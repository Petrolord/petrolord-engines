#!/usr/bin/env python3
"""Independent stdlib oracle for engines/supplychain/tender.js (Supply Chain SC2).

    python3 tools/validation/supplychain/oracle_tender.py

Writes test-data/supplychain/goldens/tender_cases.json. Reads no JavaScript.
Every rule is coded here from the published text (sources in
FINDINGS-tender.md), by a different road from the engine:

  money          exact Fractions of the input doubles; a figure leaves the
                 oracle as the nearest double only at the end. Figures that
                 are PRINTED inside a message are the one exception: the
                 engine states that it prints the double it computed in the
                 stated order, so those figures are replayed in doubles in
                 that order (left-to-right sums) and printed JavaScript-style
                 (js_num below).
  arithmetic     ITB 35.1(a)(b) as a decision table per line.
  technical      exact Fraction percentages; the pass mark compared exactly.
  omissions      the ITB 34.1 average (or the stated highest) as exact
                 Fractions over the other responsive bids' corrected amounts.
  life cycle     net present cost as an exact Fraction sum of c_t / (1+r)^t.
  scoring        exact Fractions for Sc, St and B; ties on the 12-significant-
                 digit key of the double (Decimal ROUND_HALF_UP, JavaScript's
                 toPrecision rule), then the stated tie-break.
  content        exact Fractions; the s.14 group, the lead and the s.16 margin
                 compared exactly.
  Monte Carlo    mulberry32 in unsigned 32-bit integers; the triangular
                 inverse CDF from its definition; activity days summed as
                 Fractions; basicStats' floor-index percentiles by integer
                 arithmetic; means by math.fsum (correctly rounded).
  should-cost    the wellCost duration forms and the AFE rollup re-derived
                 (drill dMD/ROP, trip 2 MD / v, casing MD / v + flat, flat;
                 per-day x days, per-meter x metres, lump as valued), the
                 partner split as 100 - sum of interests.

It also carries the worked examples the sources publish (World Bank
Guidance Figures IX to XII and Annexes 2 and 3; Kiiver and Kodym 2015 Table 1;
Chen 2008) with the printed figures beside the exact ones.
"""
import json
import math
import os
import sys
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
FIX = os.path.join(ROOT, 'test-data', 'supplychain', 'ekene-tender')
OUT = os.path.join(ROOT, 'test-data', 'supplychain', 'goldens', 'tender_cases.json')

EXCEEDANCE = 'P90 means a 90% probability the actual quantity meets or exceeds this value, per SPE PRMS.'


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
    # position of the decimal point relative to the start of `digits`
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


def plural(n, one, many=None):
    return f'{n} {one if n == 1 else (many or one + "s")}'


def key12(x):
    """Number(x.toPrecision(12)) of the double x."""
    d = Decimal(float(x))
    if d == 0:
        return 0.0
    e = d.adjusted()
    q = Decimal(1).scaleb(e - 11)
    return float(d.quantize(q, rounding=ROUND_HALF_UP))


def fl(x):
    return float(x)


def dec(x):
    """a user-typed limit read as the decimal it was typed as (0.8 is 4/5)."""
    return F(repr(float(x)))


def dsum(xs):
    """left-to-right double sum (only for figures that are printed)."""
    s = 0.0
    for v in xs:
        s = s + float(v)
    return s


def refuse(field, msg):
    return {'error': True, 'field': field, 'message': f'{field} {msg}'}


# ------------------------------------------------------------------ ranking
def rank(rows, primary, descending):
    """rows carry id, receivedAt, evaluatedCost (double) and the primary
    figure (exact). Returns [(row, rank, tieBrokenBy)]."""
    def keyp(r):
        return key12(fl(primary(r)))

    def cmp(a, b):
        ka, kb = keyp(a), keyp(b)
        if ka != kb:
            if descending:
                return (-1 if ka > kb else 1), None
            return (-1 if ka < kb else 1), None
        ca, cb = key12(fl(a['evaluatedCost'])), key12(fl(b['evaluatedCost']))
        if ca != cb:
            return (-1 if ca < cb else 1), 'lower evaluated cost'
        if a['receivedAt'] != b['receivedAt']:
            return (-1 if a['receivedAt'] < b['receivedAt'] else 1), 'earlier receipt'
        if a['id'] != b['id']:
            return (-1 if a['id'] < b['id'] else 1), 'bidder id'
        return 0, 'bidder id'

    out = []
    pool = list(rows)
    while pool:  # selection: the best remaining row each time
        best = pool[0]
        for r in pool[1:]:
            if cmp(r, best)[0] < 0:
                best = r
        pool.remove(best)
        out.append(best)
    res = []
    for i, r in enumerate(out):
        res.append((r, i + 1, None if i == 0 else cmp(out[i - 1], r)[1]))
    return res


# ------------------------------------------------------------------ WB matrix
def weighting_band(a):
    risk, cost, tw = a.get('risk'), a.get('estimatedCostUsd'), a.get('technicalWeight')
    if risk not in ('high', 'low'):
        return refuse('risk', "must be 'high' (High/Substantial) or 'low' (Moderate/Low)")
    if not isnum(cost) or cost < 0:
        return refuse('estimatedCostUsd', 'must be a finite number at or above 0')
    if 'technicalWeight' in a and (not isnum(tw) or tw < 0 or tw > 1):
        return refuse('technicalWeight', 'must be a number from 0 to 1')
    high = F(cost) >= 10000000
    # para 5.50 a-d as printed
    table = {('high', True): ('a', 0.5, 0.8), ('high', False): ('b', 0.6, 1),
             ('low', True): ('c', 0.1, 0.4), ('low', False): ('d', 0.2, 0.3)}
    cell, lo, hi = table[(risk, high)]
    out = {'cell': cell, 'highValue': high, 'min': lo, 'max': hi}
    if 'technicalWeight' in a:
        inside = lo <= tw <= hi
        out['technicalWeight'] = tw
        out['withinBand'] = inside
        out['reason'] = (f'technical weight {js_num(tw)} is inside the range {js_num(lo)} to {js_num(hi)}' if inside else
                         f'technical weight {js_num(tw)} is outside the range {js_num(lo)} to {js_num(hi)}; '
                         'misapplication of the matrix may lead to misprocurement (Annex X para 3.4)')
    return out


def isnum(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


# ------------------------------------------------------------------ arithmetic
def check_ids(lst, field):
    seen = set()
    for i, x in enumerate(lst):
        if not isinstance(x, dict):
            return refuse(f'{field}[{i}]', 'must be an object')
        if not isinstance(x.get('id'), str) or x['id'] == '':
            return refuse(f'{field}[{i}].id', 'must be a non-empty string')
        if x['id'] in seen:
            return refuse(f'{field}[{i}].id', f"repeats the id '{x['id']}'")
        seen.add(x['id'])
    return None


def check_list(lst, field, cap, least=1):
    if not isinstance(lst, list) or len(lst) < least:
        return refuse(field, f'must be an array of at least {plural(least, "entry", "entries")}')
    if len(lst) > cap:
        return refuse(field, f'has {len(lst)} entries; the cap is {cap}')
    return check_ids(lst, field)


def check_lines(lines, field):
    e = check_list(lines, field, 5000)
    if e:
        return e
    for i, l in enumerate(lines):
        for k in ('quantity', 'unitRate', 'quotedAmount'):
            if not isnum(l.get(k)) or l[k] < 0:
                return refuse(f'{field}[{i}].{k}', 'must be a finite number at or above 0')
        if 'decimalMisplaced' in l and not isinstance(l['decimalMisplaced'], bool):
            return refuse(f'{field}[{i}].decimalMisplaced', 'must be true or false when given')
        if l.get('decimalMisplaced') is True and not l['quantity'] > 0:
            return refuse(f'{field}[{i}].quantity', 'must be above 0 when decimalMisplaced is true (the unit rate is corrected as quoted amount / quantity)')
    return None


def correct_line(l, tol):
    q, r, qa = F(l['quantity']), F(l['unitRate']), F(l['quotedAmount'])
    computed = l['quantity'] * l['unitRate']      # the double the engine prints and keeps
    gap = abs(F(computed) - qa)
    base = {'id': l['id'], 'quantity': l['quantity'], 'unitRate': l['unitRate'], 'quotedAmount': l['quotedAmount']}
    if not gap > dec(tol):
        return dict(base, correctedUnitRate=l['unitRate'], correctedAmount=l['quotedAmount'], rule=None, reason=None)
    if l.get('decimalMisplaced') is True:
        rate = l['quotedAmount'] / l['quantity']
        return dict(base, correctedUnitRate=fl(qa / q), correctedAmount=l['quotedAmount'], rule='total-governs',
                    reason=(f"line {l['id']}: quantity x unit rate = {js_num(computed)} differs from the quoted {js_num(l['quotedAmount'])} "
                            f'and the decimal point in the unit rate is obviously misplaced, so the quoted amount governs and the unit rate is corrected to {js_num(rate)}'))
    return dict(base, correctedUnitRate=l['unitRate'], correctedAmount=fl(q * r), rule='unit-rate-prevails',
                reason=(f"line {l['id']}: quantity x unit rate = {js_num(computed)} differs from the quoted {js_num(l['quotedAmount'])} "
                        f'by more than {js_num(tol)}, so the unit rate prevails and the amount is corrected to {js_num(computed)}'))


def correct_arithmetic(a):
    tol = a.get('tolerance', 0.005)
    if not isnum(tol) or tol < 0:
        return refuse('tolerance', 'must be a finite number at or above 0')
    e = check_lines(a.get('lines'), 'lines')
    if e:
        return e
    if 'quotedTotal' in a and (not isnum(a['quotedTotal']) or a['quotedTotal'] < 0):
        return refuse('quotedTotal', 'must be a finite number at or above 0 when given')
    lines = [correct_line(l, tol) for l in a['lines']]
    lines_total_exact = sum((F(l['quotedAmount']) for l in a['lines']), F(0))
    qt = F(a['quotedTotal']) if 'quotedTotal' in a else lines_total_exact
    corrected_exact = sum((correct_exact(l, tol) for l in a['lines']), F(0))
    reasons = [l['reason'] for l in lines if l['reason']]
    if 'quotedTotal' in a:
        lt_double = dsum(l['quotedAmount'] for l in a['lines'])
        if abs(F(a['quotedTotal']) - F(lt_double)) > dec(tol):
            reasons.append(f"the quoted total {js_num(a['quotedTotal'])} differs from the sum of the quoted lines {js_num(lt_double)} "
                           f'by more than {js_num(tol)}; the subtotals prevail')
    return {'lines': lines, 'quotedTotal': fl(qt), 'correctedTotal': fl(corrected_exact), 'correction': fl(corrected_exact - qt),
            'linesCorrected': sum(1 for l in lines if l['rule'] is not None), 'reasons': reasons}


def correct_exact(l, tol=0.005):
    """exact corrected amount of one line (used for totals)."""
    q, r, qa = F(l['quantity']), F(l['unitRate']), F(l['quotedAmount'])
    computed = F(l['quantity'] * l['unitRate'])
    if abs(computed - qa) > dec(tol) and l.get('decimalMisplaced') is not True:
        return q * r
    return qa


# ------------------------------------------------------------------ technical
def technical(a):
    crit = a.get('criteria')
    e = check_list(crit, 'criteria', 50)
    if e:
        return e
    for i, c in enumerate(crit):
        if not isnum(c.get('weight')) or c['weight'] <= 0:
            return refuse(f'criteria[{i}].weight', 'must be a finite number above 0')
        if not isnum(c.get('maxScore')) or c['maxScore'] <= 0:
            return refuse(f'criteria[{i}].maxScore', 'must be a finite number above 0')
    wsum = dsum(c['weight'] for c in crit)
    if abs(wsum - 100) > 1e-9:
        return refuse('criteria', f'weights must sum to 100; they sum to {js_num(wsum)}')
    pm = a.get('passMark')
    if not isnum(pm) or pm < 0 or pm > 100:
        return refuse('passMark', 'must be a number from 0 to 100 (a percentage of the maximum technical score); there is no default')
    bids = a.get('bids')
    e = check_list(bids, 'bids', 100)
    if e:
        return e
    for i, b in enumerate(bids):
        if 'mandatory' in b:
            if not isinstance(b['mandatory'], list):
                return refuse(f'bids[{i}].mandatory', 'must be an array of { id, met } when given')
            for j, m in enumerate(b['mandatory']):
                if not isinstance(m, dict) or not isinstance(m.get('id'), str) or m['id'] == '' or not isinstance(m.get('met'), bool):
                    return refuse(f'bids[{i}].mandatory[{j}]', 'must be { id: a non-empty string, met: true or false }')
        if not isinstance(b.get('scores'), dict):
            return refuse(f'bids[{i}].scores', 'must be an object with one score per criterion id')
        for c in crit:
            s = b['scores'].get(c['id'])
            if not isnum(s) or s < 0 or s > c['maxScore']:
                return refuse(f"bids[{i}].scores.{c['id']}", f"must be a number from 0 to {js_num(c['maxScore'])} (the criterion's maxScore)")
    rows = []
    for b in bids:
        failed = [m['id'] for m in b.get('mandatory', []) if not m['met']]
        if failed:
            rows.append({'id': b['id'], 'status': 'fail-mandatory', 'technicalPercent': None, 'weightedPoints': None,
                         'reason': f"failed the mandatory requirement{'s' if len(failed) > 1 else ''} {', '.join(failed)}; the bid is not scored and its commercial envelope is not opened"})
            continue
        pct = sum((F(c['weight']) * F(b['scores'][c['id']]) / F(c['maxScore']) for c in crit), F(0))
        pts = sum((F(c['weight']) * F(b['scores'][c['id']]) for c in crit), F(0))
        if pct >= F(pm):
            rows.append({'id': b['id'], 'status': 'pass', 'technicalPercent': fl(pct), 'weightedPoints': fl(pts), 'reason': None})
        else:
            rows.append({'id': b['id'], 'status': 'fail-pass-mark', 'technicalPercent': fl(pct), 'weightedPoints': fl(pts),
                         'reason': f'technical score {js_num(fl(pct))} is below the pass mark {js_num(pm)}; the commercial envelope is not opened'})
    return {'bids': rows, 'passed': [r['id'] for r in rows if r['status'] == 'pass'],
            'excluded': [{'id': r['id'], 'stage': 'technical', 'reason': r['reason']} for r in rows if r['status'] != 'pass']}


# ------------------------------------------------------------------ evaluated cost
RECEIVED = __import__('re').compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')


def npc(annual, residual, rate):
    r = F(rate)
    total = F(0)
    n = len(annual)
    for t, c in enumerate(annual, start=1):
        flow = F(c) - (F(residual) if t == n else 0)
        total += flow / (1 + r) ** t
    return total


def evaluated_costs(a):
    rule = a.get('omissionRule')
    if rule not in ('average', 'highest'):
        return refuse('omissionRule', "must be 'average' (World Bank SPD ITB 34.1: the average price quoted by the substantially responsive bidders) or 'highest' (the highest price quoted by them, a stated alternative); there is no default")
    tol = a.get('tolerance', 0.005)
    if not isnum(tol) or tol < 0:
        return refuse('tolerance', 'must be a finite number at or above 0')
    best = a.get('bestEstimates', {})
    if not isinstance(best, dict):
        return refuse('bestEstimates', 'must be an object of item id to amount when given')
    for k, v in best.items():
        if not isnum(v) or v < 0:
            return refuse(f'bestEstimates.{k}', 'must be a finite number at or above 0')
    sch, lc = a.get('schedule'), a.get('lifeCycle')
    if sch is not None:
        if not isinstance(sch, dict):
            return refuse('schedule', 'must be { minWeeks, maxWeeks, ratePerWeek } when given')
        if not isnum(sch.get('minWeeks')) or sch['minWeeks'] < 0:
            return refuse('schedule.minWeeks', 'must be a finite number at or above 0')
        if not isnum(sch.get('maxWeeks')) or sch['maxWeeks'] < sch['minWeeks']:
            return refuse('schedule.maxWeeks', 'must be a finite number at or above minWeeks')
        if not isnum(sch.get('ratePerWeek')) or not 0 <= sch['ratePerWeek'] <= 1:
            return refuse('schedule.ratePerWeek', 'must be a fraction from 0 to 1 of the price for each week beyond minWeeks')
    if lc is not None:
        if not isinstance(lc, dict):
            return refuse('lifeCycle', 'must be { years, discountRate } when given')
        y = lc.get('years')
        if not (isinstance(y, int) and not isinstance(y, bool)) or not 1 <= y <= 100:
            return refuse('lifeCycle.years', 'must be a whole number from 1 to 100')
        if not isnum(lc.get('discountRate')) or lc['discountRate'] <= -1 or lc['discountRate'] > 1:
            return refuse('lifeCycle.discountRate', 'must be a fraction above -1 and at most 1 (0.1 is 10 percent a year)')
    bids = a.get('bids')
    e = check_list(bids, 'bids', 100)
    if e:
        return e
    for i, b in enumerate(bids):
        if not isinstance(b.get('receivedAt'), str) or not RECEIVED.match(b['receivedAt']):
            return refuse(f'bids[{i}].receivedAt', "must be a UTC time 'YYYY-MM-DDTHH:MM:SSZ'")
        e = check_lines(b.get('lines'), f'bids[{i}].lines')
        if e:
            return e
        if 'discount' in b and (not isnum(b['discount']) or b['discount'] < 0):
            return refuse(f'bids[{i}].discount', 'must be a finite number at or above 0 when given')
        if 'deviations' in b:
            if not isinstance(b['deviations'], list):
                return refuse(f'bids[{i}].deviations', 'must be an array of { id, amount, reason } when given')
            for j, d in enumerate(b['deviations']):
                if not isinstance(d, dict) or not isinstance(d.get('id'), str) or not isnum(d.get('amount')) or not isinstance(d.get('reason'), str):
                    return refuse(f'bids[{i}].deviations[{j}]', 'must be { id: a string, amount: a finite number, reason: a string }')
        if 'omitted' in b:
            om = b['omitted']
            if not isinstance(om, list) or any(not isinstance(x, str) or x == '' for x in om):
                return refuse(f'bids[{i}].omitted', 'must be an array of item ids when given')
            priced = {l['id'] for l in b['lines']}
            both = [x for x in om if x in priced]
            if both:
                return refuse(f'bids[{i}].omitted', f"lists '{both[0]}', which the bid also prices")
            if len(set(om)) != len(om):
                return refuse(f'bids[{i}].omitted', 'repeats an item id')
        if 'rejected' in b and (not isinstance(b['rejected'], str) or b['rejected'] == ''):
            return refuse(f'bids[{i}].rejected', 'must be a non-empty reason string when given')
        if sch is not None and (not isnum(b.get('completionWeeks')) or b['completionWeeks'] < 0):
            return refuse(f'bids[{i}].completionWeeks', 'must be a finite number at or above 0 when a schedule is given')
        if lc is not None:
            ac = b.get('annualCosts')
            if not isinstance(ac, list) or len(ac) != lc['years'] or any(not isnum(x) for x in ac):
                return refuse(f'bids[{i}].annualCosts', f"must be an array of {plural(lc['years'], 'finite number')}, one per life-cycle year")
            if 'residualValue' in b and not isnum(b['residualValue']):
                return refuse(f'bids[{i}].residualValue', 'must be a finite number when given')
    excluded, live = [], []
    for b in bids:
        if b.get('rejected'):
            excluded.append({'id': b['id'], 'stage': 'commercial', 'reason': b['rejected']})
        elif sch is not None and F(b['completionWeeks']) > F(sch['maxWeeks']):
            excluded.append({'id': b['id'], 'stage': 'commercial',
                             'reason': f"offers completion in {js_num(b['completionWeeks'])} weeks, beyond the maximum {js_num(sch['maxWeeks'])}; the bid is nonresponsive"})
        else:
            live.append(b)

    def amount_of(b, item):
        for l in b['lines']:
            if l['id'] == item:
                return correct_exact(l, tol), fl_line(l, tol)
        return None

    rows = []
    for b in live:
        corr = correct_arithmetic({'lines': b['lines'], 'tolerance': tol})
        omissions = []
        for item in b.get('omitted', []):
            got = [amount_of(o, item) for o in live if o['id'] != b['id']]
            got = [g for g in got if g is not None]
            if not got:
                if item not in best:
                    return refuse(f'bestEstimates.{item}', f"is required: bid {b['id']} omits item {item} and no other responsive bid prices it")
                omissions.append({'item': item, 'exact': F(best[item]), 'amount': best[item], 'rule': 'best-estimate',
                                  'reason': f"item {item} omitted; no other responsive bid prices it, so the Employer's best estimate {js_num(best[item])} is added"})
            elif rule == 'average':
                ex = sum((g[0] for g in got), F(0)) / len(got)
                shown = dsum(g[1] for g in got) / len(got)
                omissions.append({'item': item, 'exact': ex, 'amount': fl(ex), 'rule': 'average',
                                  'reason': f'item {item} omitted; the average of the {plural(len(got), "price")} quoted by the other responsive bids, {js_num(shown)}, is added'})
            else:
                ex = max(g[0] for g in got)
                omissions.append({'item': item, 'exact': ex, 'amount': fl(ex), 'rule': 'highest',
                                  'reason': f'item {item} omitted; the highest of the {plural(len(got), "price")} quoted by the other responsive bids, {js_num(max(g[1] for g in got))}, is added'})
        corrected = sum((correct_exact(l, tol) for l in b['lines']), F(0))
        quoted = sum((F(l['quotedAmount']) for l in b['lines']), F(0))
        disc = F(b.get('discount', 0))
        net = corrected - disc
        net_shown = dsum(fl_line(l, tol) for l in b['lines']) - b.get('discount', 0)
        devs = [{'id': d['id'], 'amount': d['amount'], 'reason': d['reason']} for d in b.get('deviations', [])]
        sadj, sreason = F(0), None
        if sch is not None:
            late = max(F(0), F(b['completionWeeks']) - F(sch['minWeeks']))
            sadj = F(sch['ratePerWeek']) * late * net
            late_shown = max(0, b['completionWeeks'] - sch['minWeeks'])
            if late > 0:
                sreason = (f"completion in {js_num(b['completionWeeks'])} weeks is {js_num(late_shown)} weeks beyond the minimum {js_num(sch['minWeeks'])}; "
                           f"{js_num(sch['ratePerWeek'])} x {js_num(late_shown)} x {js_num(net_shown)} = {js_num(sch['ratePerWeek'] * late_shown * net_shown)} is added")
            else:
                sreason = (f"completion in {js_num(b['completionWeeks'])} weeks is not beyond the minimum {js_num(sch['minWeeks'])}; "
                           'no adjustment and no credit for earlier completion')
        life = npc(b['annualCosts'], b.get('residualValue', 0), lc['discountRate']) if lc is not None else F(0)
        om_total = sum((o['exact'] for o in omissions), F(0))
        dev_total = sum((F(d['amount']) for d in devs), F(0))
        ev = net + dev_total + om_total + sadj + life
        reasons = list(corr['reasons']) + [o['reason'] for o in omissions] + [f"deviation {d['id']}: {d['reason']} ({js_num(d['amount'])})" for d in devs] + ([sreason] if sreason else [])
        rows.append({'id': b['id'], 'receivedAt': b['receivedAt'], 'quotedTotal': fl(quoted), 'correctedPrice': fl(corrected),
                     'arithmeticCorrection': fl(corrected - quoted), 'discount': b.get('discount', 0), 'deviations': devs, 'deviationTotal': fl(dev_total),
                     'omissions': [{k: v for k, v in o.items() if k != 'exact'} for o in omissions], 'omissionTotal': fl(om_total),
                     'scheduleAdjustment': fl(sadj), 'scheduleReason': sreason, 'lifeCycleCost': fl(life), 'evaluatedCost': fl(ev), 'reasons': reasons,
                     '_exact': ev})
    ranked = rank(rows, lambda r: r['_exact'], False)
    out = []
    for r, k, by in ranked:
        d = {kk: vv for kk, vv in r.items() if kk != '_exact'}
        d['rank'], d['tieBrokenBy'] = k, by
        out.append(d)
    return {'bids': out, 'lowestEvaluatedCost': out[0]['id'] if out else None, 'excluded': excluded}


def fl_line(l, tol):
    """the corrected amount as the double the engine holds (q x r in doubles when the unit rate prevails)."""
    computed = l['quantity'] * l['unitRate']
    if abs(F(computed) - F(l['quotedAmount'])) > dec(tol) and l.get('decimalMisplaced') is not True:
        return computed
    return l['quotedAmount']


# ------------------------------------------------------------------ combined score
def rank_tender(a):
    tw, pmeth, tmeth = a.get('technicalWeight'), a.get('priceMethod'), a.get('technicalMethod')
    if not isnum(tw) or tw < 0 or tw > 1:
        return refuse('technicalWeight', 'must be a number from 0 to 1 (the technical share of the combined score); there is no default')
    if pmeth not in ('lowest-ratio', 'linear', 'mean-deviation'):
        return refuse('priceMethod', "must be 'lowest-ratio', 'linear' or 'mean-deviation'; there is no default")
    if tmeth not in ('relative', 'absolute'):
        return refuse('technicalMethod', "must be 'relative' (100 x T / Thigh) or 'absolute' (T as scored); there is no default")
    bids = a.get('bids')
    e = check_list(bids, 'bids', 100)
    if e:
        return e
    for i, b in enumerate(bids):
        if not isnum(b.get('technicalPercent')) or not 0 <= b['technicalPercent'] <= 100:
            return refuse(f'bids[{i}].technicalPercent', 'must be a number from 0 to 100')
        if not isnum(b.get('evaluatedCost')) or b['evaluatedCost'] <= 0:
            return refuse(f'bids[{i}].evaluatedCost', 'must be a finite number above 0')
        if not isinstance(b.get('receivedAt'), str) or not RECEIVED.match(b['receivedAt']):
            return refuse(f'bids[{i}].receivedAt', "must be a UTC time 'YYYY-MM-DDTHH:MM:SSZ'")
        if 'rejected' in b and (not isinstance(b['rejected'], str) or b['rejected'] == ''):
            return refuse(f'bids[{i}].rejected', 'must be a non-empty reason string when given')
    excluded = [{'id': b['id'], 'stage': 'commercial', 'reason': b['rejected']} for b in bids if b.get('rejected')]
    live = [b for b in bids if not b.get('rejected')]
    if not live:
        return refuse('bids', 'has no bid left to score: every bid is rejected')
    t_high = max(F(b['technicalPercent']) for b in live)
    if tmeth == 'relative' and t_high == 0:
        return refuse('bids', "all score 0 technically, so Thigh is 0 and the 'relative' technical score is undefined")
    costs = [F(b['evaluatedCost']) for b in live]
    cmin, cmax = min(costs), max(costs)
    cmean = sum(costs, F(0)) / len(costs)
    W = F(tw)
    rows = []
    for b in live:
        c = F(b['evaluatedCost'])
        st = 100 * F(b['technicalPercent']) / t_high if tmeth == 'relative' else F(b['technicalPercent'])
        if pmeth == 'lowest-ratio':
            sc = 100 * cmin / c
        elif pmeth == 'linear':
            sc = F(100) if cmax == cmin else 100 * (cmax - c) / (cmax - cmin)
        else:
            sc = max(F(0), 100 * (1 - abs(c - cmean) / cmean))
        bsc = W * st + (1 - W) * sc
        rows.append({'id': b['id'], 'receivedAt': b['receivedAt'], 'technicalPercent': b['technicalPercent'], 'evaluatedCost': b['evaluatedCost'],
                     'technicalScore': fl(st), 'commercialScore': fl(sc), 'combinedScore': fl(bsc), '_b': bsc})
    ranked = rank(rows, lambda r: r['_b'], True)
    out = []
    for r, k, by in ranked:
        d = {kk: vv for kk, vv in r.items() if kk != '_b'}
        d['rank'], d['tieBrokenBy'] = k, by
        out.append(d)
    return {'bids': out, 'mostAdvantageous': out[0]['id'], 'excluded': excluded,
            'cMin': fl(cmin), 'cMax': fl(cmax), 'cMean': fl(cmean), 'tHigh': fl(t_high)}


# ------------------------------------------------------------------ Nigerian content
# NOGICD Act 2010, Schedule, transcribed from the NCDMB copy (nc-act.pdf) and
# checked against the FAOLEX copy: key -> (percent, measured units).
SCHEDULE = {
    'steel-plates-flat-sheets-sections': (100, ['tonnage']), 'steel-pipes': (100, ['tonnage']),
    'low-voltage-cables': (90, ['length']), 'high-voltage-cables': (45, ['length']), 'valves': (60, ['number']),
    'drilling-mud-baryte-bentonite': (60, ['tonnage']), 'cement-portland': (80, ['tonnage']), 'cement-hydraulic': (60, ['tonnage']),
    'heat-exchangers': (50, ['number']), 'steel-ropes': (60, ['tonnage']), 'protective-paints': (60, ['litres']), 'gre-pipes': (60, ['tonnage']),
    'reservoir-services': (75, ['spend']), 'well-completion-services': (80, ['spend']), 'wireline-services': (45, ['spend']),
    'lwd-services': (75, ['man-hours']), 'mwd-services': (90, ['man-hours']), 'production-drilling-service': (85, ['man-hours']),
    'performance-services-t-and-p': (90, ['man-hours']), 'well-overhauling-stimulation-services': (85, ['man-hours']),
    'wellhead-services': (85, ['man-hours']), 'directional-surveying-services': (100, ['man-hours']),
    'cutting-injection-disposal-services': (100, ['man-hours']), 'cased-hole-logging-services': (90, ['man-hours']),
    'well-watch-services': (70, ['man-hours']), 'cement-service': (75, ['man-hours']), 'coiled-tubing-services': (75, ['man-hours']),
    'pumping-services': (95, ['man-hours']), 'fluid-bottom-hole-sampling-services': (80, ['man-hours']), 'octg-services': (95, ['man-hours']),
    'well-crisis-management-services': (90, ['man-hours']), 'directional-drilling-services': (90, ['man-hours']),
    'other-drilling-services': (80, ['man-hours']), 'rental-of-drill-pipe': (75, ['spend']), 'well-head-safety-panels': (100, ['spend']),
    'chemicals-drilling-process-maintenance': (90, ['spend']), 'mud-logging-services': (90, ['spend']), 'coring-services': (90, ['spend']),
    'well-testing-service': (55, ['spend']), 'drilling-rigs-swamp': (60, ['man-hours']), 'drilling-rigs-offshore': (55, ['man-hours']),
    'drilling-rigs-land': (70, ['man-hours']), 'work-over-rigs-swamp': (70, ['spend']), 'snubbing-services': (80, ['spend']),
    'liner-float-hangers-running-equipment': (55, ['spend']),
}
SECTION = {}
for k in list(SCHEDULE)[:12]:
    SECTION[k] = 'MATERIALS AND PROCUREMENT'
for k in list(SCHEDULE)[12:36]:
    SECTION[k] = 'WELL AND DRILLING SERVICES/PETROLEUM TECHNOLOGY'
for k in list(SCHEDULE)[36:]:
    SECTION[k] = 'EXPLORATION, SUBSURFACE, PETROLEUM ENGINEERING AND SEISMIC'
MEASURES = ['man-hours', 'tonnage', 'spend', 'length', 'number', 'volume', 'litres']


def nigerian_content(a, descriptions):
    items = a.get('items')
    e = check_list(items, 'items', 200)
    if e:
        return e
    spec = []
    for i, it in enumerate(items):
        if 'scheduleLine' in it:
            if it['scheduleLine'] not in SCHEDULE:
                return refuse(f'items[{i}].scheduleLine', f"'{it['scheduleLine']}' is not a line of NC_SCHEDULE; state targetPct, measure and source instead")
            pct, ms = SCHEDULE[it['scheduleLine']]
            src = (f"Nigerian Oil and Gas Industry Content Development Act 2010 s.11 and the Schedule, {SECTION[it['scheduleLine']]}: "
                   f"{descriptions[it['scheduleLine']]} {pct}% by {' or '.join(ms)}")
            spec.append({'id': it['id'], 'targetPct': pct, 'measures': ms, 'source': src})
        else:
            if not isnum(it.get('targetPct')) or not 0 <= it['targetPct'] <= 100:
                return refuse(f'items[{i}].targetPct', 'must be a number from 0 to 100 when no scheduleLine is given')
            if it.get('measure') not in MEASURES:
                return refuse(f'items[{i}].measure', f"must be one of {', '.join(MEASURES)}")
            if not isinstance(it.get('source'), str) or it['source'] == '':
                return refuse(f'items[{i}].source', 'must state where the target comes from (a user-stated target is never a hidden default)')
            spec.append({'id': it['id'], 'targetPct': it['targetPct'], 'measures': [it['measure']], 'source': f"stated by the user: {it['source']}"})
    bids = a.get('bids')
    e = check_list(bids, 'bids', 100)
    if e:
        return e
    one = len({s['measures'][0] if len(s['measures']) == 1 else '*' + s['id'] for s in spec}) == 1
    for i, b in enumerate(bids):
        if not isinstance(b.get('items'), dict):
            return refuse(f'bids[{i}].items', 'must be an object with one { measure, nigerian, total } per item id')
        for s in spec:
            r = b['items'].get(s['id'])
            f = f"bids[{i}].items.{s['id']}"
            if not isinstance(r, dict):
                return refuse(f, 'is missing: every bid reports every item')
            if r.get('measure') not in s['measures']:
                return refuse(f'{f}.measure', f"must be {' or '.join(repr_q(m) for m in s['measures'])}, the unit the minimum is measured in; got '{r.get('measure')}'")
            if not isnum(r.get('total')) or r['total'] <= 0:
                return refuse(f'{f}.total', 'must be a finite number above 0')
            if not isnum(r.get('nigerian')) or r['nigerian'] < 0 or r['nigerian'] > r['total']:
                return refuse(f'{f}.nigerian', 'must be a number from 0 to total')
        if not one:
            w = b.get('weights')
            if not isinstance(w, dict):
                return refuse(f'bids[{i}].weights', 'are required: the items are measured in different units, so the overall content is the weighted mean of the item contents with stated weights (for example the priced amount of each item)')
            for s in spec:
                if not isnum(w.get(s['id'])) or w[s['id']] < 0:
                    return refuse(f"bids[{i}].weights.{s['id']}", 'must be a finite number at or above 0')
            if sum(F(w[s['id']]) for s in spec) <= 0:
                return refuse(f'bids[{i}].weights', 'must not all be 0')
    rows = []
    for b in bids:
        its = []
        exact = []
        for s in spec:
            r = b['items'][s['id']]
            p = 100 * F(r['nigerian']) / F(r['total'])
            meets = p >= F(s['targetPct'])
            exact.append(p)
            its.append({'id': s['id'], 'measure': r['measure'], 'nigerian': r['nigerian'], 'total': r['total'], 'ncPct': fl(p),
                        'targetPct': s['targetPct'], 'meets': meets, 'shortfallPct': 0 if meets else fl(F(s['targetPct']) - p)})
        if one:
            tot = 100 * sum((F(b['items'][s['id']]['nigerian']) for s in spec), F(0)) / sum((F(b['items'][s['id']]['total']) for s in spec), F(0))
        else:
            w = [F(b['weights'][s['id']]) for s in spec]
            tot = sum((wi * p for wi, p in zip(w, exact)), F(0)) / sum(w, F(0))
        short = [x for x in its if not x['meets']]
        rows.append({'id': b['id'], 'items': its, 'ncPct': fl(tot), 'itemsMet': len(its) - len(short), 'allMet': not short,
                     'reasons': [f"item {x['id']}: Nigerian content {js_num((100 * b['items'][x['id']]['nigerian']) / b['items'][x['id']]['total'])}% by {x['measure']} is below the minimum {js_num(x['targetPct'])}%" for x in short]})
    return {'bids': rows, 'aggregate': 'one-measure' if one else 'weighted',
            'targets': [{'id': s['id'], 'targetPct': s['targetPct'], 'measures': list(s['measures']), 'source': s['source']} for s in spec]}


def repr_q(m):
    return f"'{m}'"


def content_preference(a):
    basis = a.get('ncLeadBasis')
    if basis not in ('points', 'relative'):
        return refuse('ncLeadBasis', "must be 'points' (at least 5 percentage points more) or 'relative' (at least 5 percent more than the runner-up's content); s.14 does not say which, so there is no default")
    bids = a.get('bids')
    e = check_list(bids, 'bids', 100)
    if e:
        return e
    for i, b in enumerate(bids):
        if not isnum(b.get('evaluatedCost')) or b['evaluatedCost'] <= 0:
            return refuse(f'bids[{i}].evaluatedCost', 'must be a finite number above 0')
        if not isnum(b.get('ncPct')) or not 0 <= b['ncPct'] <= 100:
            return refuse(f'bids[{i}].ncPct', 'must be a number from 0 to 100')
        if not isinstance(b.get('receivedAt'), str) or not RECEIVED.match(b['receivedAt']):
            return refuse(f'bids[{i}].receivedAt', "must be a UTC time 'YYYY-MM-DDTHH:MM:SSZ'")
        for k in ('indigenous', 'capacity'):
            if k in b and not isinstance(b[k], bool):
                return refuse(f'bids[{i}].{k}', 'must be true or false when given')
    ordered = [r for r, _, _ in rank([dict(b) for b in bids], lambda r: F(r['evaluatedCost']), False)]
    low = ordered[0]
    cmin = F(low['evaluatedCost'])
    # s.14: "within 1 % of each other at commercial stage" read as within 1% of the lowest
    group = [b for b in ordered if (F(b['evaluatedCost']) - cmin) * 100 <= cmin]
    s14 = {'engaged': False, 'group': [b['id'] for b in group], 'leader': None, 'runnerUp': None, 'lead': None,
           'leadBasis': basis, 'applied': False, 'reason': None}
    selected = low['id']
    if len(group) < 2:
        s14['reason'] = f"only {low['id']} is within 1% of the lowest evaluated cost {js_num(low['evaluatedCost'])}; s.14 is not engaged"
    else:
        s14['engaged'] = True
        hi = max(F(b['ncPct']) for b in group)
        tops = [b for b in group if F(b['ncPct']) == hi]
        if len(tops) > 1:
            s14['reason'] = (f"{' and '.join(b['id'] for b in tops)} share the highest Nigerian content {js_num(tops[0]['ncPct'])}%, "
                             f"so no single bid leads; the lowest evaluated cost {low['id']} stands")
        else:
            top = tops[0]
            rest = [b for b in group if b is not top]
            nxt = max(F(b['ncPct']) for b in rest)
            second = [b for b in group if b is not top and F(b['ncPct']) == nxt][0]  # first in cost order
            s14['leader'], s14['runnerUp'] = top['id'], second['id']
            t, s = F(top['ncPct']), F(second['ncPct'])
            if basis == 'points':
                lead = t - s
                ok = lead >= 5
                s14['lead'] = fl(lead)
                lead_text = f"{js_num(top['ncPct'])}% against {js_num(second['ncPct'])}% ({second['id']}), a lead of {js_num(top['ncPct'] - second['ncPct'])} percentage points"
            else:
                ok = 100 * (t - s) >= 5 * s
                if s == 0:
                    s14['lead'] = None
                    lead_text = f"{js_num(top['ncPct'])}% against 0% ({second['id']}), more than 5% higher by any reading"
                else:
                    s14['lead'] = fl(100 * (t - s) / s)
                    shown = (100 * (top['ncPct'] - second['ncPct'])) / second['ncPct']
                    lead_text = f"{js_num(top['ncPct'])}% against {js_num(second['ncPct'])}% ({second['id']}), {js_num(shown)}% higher"
            n = plural(len(group), 'bid')
            if ok:
                s14['applied'] = True
                selected = top['id']
                if top['id'] == low['id']:
                    s14['reason'] = f"{top['id']} is the lowest evaluated cost and also leads on Nigerian content, {lead_text}; s.14 confirms it"
                else:
                    s14['reason'] = (f"{n} within 1% of the lowest evaluated cost; {top['id']} has the highest Nigerian content, {lead_text}, "
                                     f"at least 5% higher, so s.14 selects {top['id']} over the lowest evaluated cost {low['id']}")
            else:
                s14['reason'] = (f"{n} within 1% of the lowest evaluated cost; {top['id']} has the highest Nigerian content, {lead_text}, "
                                 f"less than 5% higher, so the lowest evaluated cost {low['id']} stands")
    s16 = []
    for b in ordered:
        if b.get('indigenous') is True and b.get('capacity') is True:
            c = F(b['evaluatedCost'])
            within = (c - cmin) * 10 <= cmin
            above_shown = (100 * (b['evaluatedCost'] - low['evaluatedCost'])) / low['evaluatedCost']
            s16.append({'id': b['id'], 'abovePct': fl(100 * (c - cmin) / cmin), 'withinMargin': within,
                        'reason': (f"{b['id']} is a Nigerian indigenous company with capacity, {js_num(above_shown)}% above the lowest evaluated cost, within 10 percent: "
                                   'it is not disqualified solely because it is not the lowest (s.16)') if within else
                        (f"{b['id']} is a Nigerian indigenous company with capacity, {js_num(above_shown)}% above the lowest evaluated cost, "
                         'more than 10 percent above: s.16 does not protect it')})
    return {'lowestEvaluatedCost': low['id'], 'section14': s14, 'section16': s16, 'selected': selected}


# ------------------------------------------------------------------ programme days (wellCost forms)
def productive_hours(a):
    k = a['kind']
    if k == 'drill':
        return F(a['toMdM']) - F(a['fromMdM']), (F(a['toMdM']) - F(a['fromMdM'])) / F(a['ropMPerHr'])
    if k == 'trip':
        return F(0), 2 * F(a['mdM']) / F(a['tripSpeedMPerHr'])
    if k == 'casing':
        return F(0), F(a['mdM']) / F(a['runSpeedMPerHr']) + F(a.get('flatHr', 0))
    if k == 'flat':
        return F(0), F(a['durationHr'])
    raise ValueError(k)


def program_days(acts, npt):
    hrs = sum((productive_hours(a)[1] for a in acts), F(0))
    drilled = sum((productive_hours(a)[0] for a in acts), F(0))
    return hrs * (1 + F(npt)) / 24, drilled


# ------------------------------------------------------------------ Monte Carlo
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

    def at(p10):  # p10 in tenths: floor(p n)
        return s[min((p10 * n) // 10, n - 1)]
    return {'mean': math.fsum(s) / n, 'p90': at(1), 'p50': at(5), 'p10': at(9), 'min': s[0], 'max': s[-1]}


def tri(d):
    return {'min': d, 'mode': d, 'max': d} if isnum(d) else d


def contract_types(a):
    it, seed = a.get('iterations'), a.get('seed')
    if not (isinstance(it, int) and not isinstance(it, bool)) or not 1 <= it <= 200000:
        return refuse('iterations', 'must be a whole number from 1 to 200000')
    if not (isinstance(seed, int) and not isinstance(seed, bool)) or not 0 <= seed <= 4294967295:
        return refuse('seed', 'must be a whole number from 0 to 4294967295; there is no default, so every run can be reproduced')
    dur = a.get('duration')
    prog = None
    if isinstance(dur, dict) and 'program' in dur:
        e = check_tri(dur.get('nptFrac'), 'duration.nptFrac')
        if e:
            return e
        prog = dur['program']
        dtri = tri(dur['nptFrac'])
    else:
        e = check_tri(dur, 'duration')
        if e:
            return e
        dtri = tri(dur)
    e = check_tri(a.get('dailyCost'), 'dailyCost')
    if e:
        return e
    ctri = tri(a['dailyCost'])
    fixed = a.get('fixedCost', 0)
    if not isnum(fixed) or fixed < 0:
        return refuse('fixedCost', 'must be a finite number at or above 0')
    ls, dr, rb = a.get('lumpSum'), a.get('dayRate'), a.get('reimbursable')
    if not isinstance(ls, dict) or not isnum(ls.get('price')) or ls['price'] < 0:
        return refuse('lumpSum', 'must be { price } with price at or above 0')
    if not isinstance(dr, dict) or not isnum(dr.get('rate')) or dr['rate'] < 0 or not isnum(dr.get('mobilisationFee')) or dr['mobilisationFee'] < 0:
        return refuse('dayRate', 'must be { rate, mobilisationFee }, both at or above 0')
    if not isinstance(rb, dict) or (('feeFraction' in rb) == ('fixedFee' in rb)):
        return refuse('reimbursable', 'must state exactly one of feeFraction (cost plus a percentage) or fixedFee (cost plus a fixed fee)')
    if 'feeFraction' in rb and (not isnum(rb['feeFraction']) or not 0 <= rb['feeFraction'] <= 1):
        return refuse('reimbursable.feeFraction', 'must be a fraction from 0 to 1')
    if 'fixedFee' in rb and (not isnum(rb['fixedFee']) or rb['fixedFee'] < 0):
        return refuse('reimbursable.fixedFee', 'must be a finite number at or above 0')

    def days_of(x):
        return float(program_days(prog, x)[0]) if prog is not None else x

    plan = a.get('plan')
    if plan is not None and (not isinstance(plan, dict) or not isnum(plan.get('days')) or plan['days'] < 0 or not isnum(plan.get('dailyCost')) or plan['dailyCost'] < 0):
        return refuse('plan', 'must be { days, dailyCost }, both at or above 0, when given')
    d0 = plan['days'] if plan else days_of(dtri['mode'])
    r0 = plan['dailyCost'] if plan else ctri['mode']
    cost0 = F(fixed) + F(d0) * F(r0)

    def pay(kind, days, cost):
        if kind == 'lumpSum':
            return F(ls['price'])
        if kind == 'dayRate':
            return F(dr['mobilisationFee']) + F(dr['rate']) * F(days)
        if 'feeFraction' in rb:
            return cost * (1 + F(rb['feeFraction']))
        return cost + F(rb['fixedFee'])

    kinds = ['lumpSum', 'dayRate', 'reimbursable']
    p0 = {k: pay(k, d0, cost0) for k in kinds}
    rng = Mulberry32(seed)
    comp = {k: [] for k in kinds}
    marg = {k: [] for k in kinds}
    cp = {k: F(0) for k in kinds}
    ca = {k: F(0) for k in kinds}
    loss = {k: 0 for k in kinds}
    days_all, cost_all = [], []
    over_sum, overs = F(0), 0
    for _ in range(it):
        x = tri_inv(rng(), dtri['min'], dtri['mode'], dtri['max']) if dtri['max'] > dtri['min'] else dtri['mode']
        days = days_of(x)
        rate = tri_inv(rng(), ctri['min'], ctri['mode'], ctri['max']) if ctri['max'] > ctri['min'] else ctri['mode']
        cost = F(fixed) + F(days) * F(rate)
        days_all.append(days)
        cost_all.append(float(cost))
        over = cost > cost0
        if over:
            overs += 1
            over_sum += cost - cost0
        for k in kinds:
            p = pay(k, days, cost)
            m = p - cost
            comp[k].append(float(p))
            marg[k].append(float(m))
            if m < 0:
                loss[k] += 1
            if over:
                cp[k] += p - p0[k]
                ca[k] += (p0[k] - cost0) - m
    exp_over = over_sum / it
    types = {}
    for k in kinds:
        cps = cp[k] / it
        types[k] = {'plannedPayment': fl(p0[k]), 'companyCost': summary(comp[k]),
                    'contractorMargin': {'mean': math.fsum(marg[k]) / it, 'planned': fl(p0[k] - cost0), 'probabilityOfLoss': loss[k] / it},
                    'overrun': {'companyPays': fl(cps), 'contractorAbsorbs': fl(ca[k] / it), 'companyShare': fl(cps / exp_over) if exp_over > 0 else None}}
    return {'plan': {'days': fl(d0), 'dailyCost': r0, 'contractorCost': fl(cost0)}, 'duration': summary(days_all), 'contractorCost': summary(cost_all),
            'overrun': {'probability': overs / it, 'expectedOverrun': fl(exp_over)}, 'types': types, 'percentileDefinition': EXCEEDANCE}


def check_tri(d, field):
    if isnum(d):
        return None if d >= 0 else refuse(field, 'must be at or above 0')
    if not isinstance(d, dict) or not all(isnum(d.get(k)) for k in ('min', 'mode', 'max')):
        return refuse(field, 'must be a number or { min, mode, max } (triangular)')
    if d['min'] < 0:
        return refuse(f'{field}.min', 'must be at or above 0')
    if not d['min'] <= d['mode'] <= d['max']:
        return refuse(field, 'must have min <= mode <= max')
    return None


# ------------------------------------------------------------------ should-cost
def should_cost(a):
    band = a.get('band')
    if not isinstance(band, dict) or not isnum(band.get('low')) or not isnum(band.get('high')) or band['low'] <= 0 or band['high'] < band['low']:
        return refuse('band', 'must be { low, high } with 0 < low <= high (ratios of bid to estimate); there is no default')
    if not isinstance(a.get('program'), list) or not a['program']:
        return refuse('program', 'or its cost items are refused by engines/drilling/wellCost.js: The program has no activities.')
    days, drilled = program_days(a['program'], a.get('nptFrac', 0))
    base = F(0)
    for it in a['items']:
        if it['basis'] == 'per-day':
            base += F(it['rate']) * days
        elif it['basis'] == 'per-meter':
            base += F(it['rate']) * drilled
        else:
            base += F(it['value'])
    cont = F(a.get('contingencyFrac', 0)) * base
    est = base + cont
    out = {'totalDays': fl(days), 'drilledM': fl(drilled), 'baseUsd': fl(base), 'contingencyUsd': fl(cont), 'estimate': fl(est)}
    split = None
    if 'partners' in a:
        wi = [F(p['working_interest']) for p in a['partners']]
        op = 100 - sum(wi, F(0))
        split = {'operatorShare': fl(op), 'operatorAmount': fl(est * op / 100),
                 'partners': [{'name': p['name'], 'working_interest': p['working_interest'], 'shareAmount': fl(est * w / 100)} for p, w in zip(a['partners'], wi)],
                 'valid': op >= 0 and all(w >= 0 for w in wi), 'note': None}
    out['split'] = split
    bids = a.get('bids')
    e = check_list(bids, 'bids', 100)
    if e:
        return e
    for i, b in enumerate(bids):
        if not isnum(b.get('evaluatedCost')) or b['evaluatedCost'] < 0:
            return refuse(f'bids[{i}].evaluatedCost', 'must be a finite number at or above 0')
    est_double = float(est)
    rows = []
    for b in bids:
        ratio = F(b['evaluatedCost']) / est
        flag = 'below' if ratio < dec(band['low']) else 'above' if ratio > dec(band['high']) else None
        shown = b['evaluatedCost'] / est_double
        rows.append({'id': b['id'], 'evaluatedCost': b['evaluatedCost'], 'ratio': fl(ratio), 'flag': flag,
                     'reason': (f"bid-to-estimate ratio {js_num(shown)} is below the band's lower limit {js_num(band['low'])}: examine it as a possibly abnormally low bid" if flag == 'below' else
                                f"bid-to-estimate ratio {js_num(shown)} is above the band's upper limit {js_num(band['high'])}" if flag == 'above' else None)})
    out['bids'] = rows
    return out


# ------------------------------------------------------------------ abnormally low bids
def abnormally_low(a):
    bids = a.get('bids')
    e = check_list(bids, 'bids', 100)
    if e:
        return e
    for i, b in enumerate(bids):
        if not isnum(b.get('evaluatedCost')) or b['evaluatedCost'] <= 0:
            return refuse(f'bids[{i}].evaluatedCost', 'must be a finite number above 0')
    n = len(bids)
    est = a.get('estimate')
    approach = 'absolute' if n < 5 else 'relative'
    if approach == 'absolute' and (not isnum(est) or est <= 0):
        return refuse('estimate', f"is required: with {plural(n, 'substantially responsive bid')} (fewer than 5) the absolute approach compares each bid with the Borrower's cost estimate")
    if 'estimate' in a and (not isnum(est) or est <= 0):
        return refuse('estimate', 'must be a finite number above 0 when given')
    clarify = 'a potential abnormally low bid: clarify the price with the bidder before any decision; it is never rejected automatically'
    rows = []
    mean = sd = limit = None
    if approach == 'relative':
        xs = [F(b['evaluatedCost']) for b in bids]
        m = sum(xs, F(0)) / n
        var = sum(((x - m) ** 2 for x in xs), F(0)) / n          # population variance
        getcontext_prec = Decimal(var.numerator) / Decimal(var.denominator)
        sdd = getcontext_prec.sqrt()
        mean, sd = fl(m), float(sdd)
        lim = m - F(sdd)
        limit = fl(lim)
        # printed figures: the doubles in the engine's order (lib/stats mean, then population SD about it)
        md = math.fsum(float(x) for x in xs) / n
        vd = 0.0
        for x in xs:
            vd = vd + (float(x) - md) * (float(x) - md)
        sdd_print = math.sqrt(vd / n)
    for b in bids:
        c = b['evaluatedCost']
        if approach == 'absolute':
            flag = 100 * (F(est) - F(c)) >= 20 * F(est)
            shown = (100 * (est - c)) / est
            rows.append({'id': b['id'], 'evaluatedCost': c, 'belowEstimatePct': fl(100 * (F(est) - F(c)) / F(est)), 'flag': flag,
                         'reason': f"{b['id']}: evaluated cost {js_num(c)} is {js_num(shown)}% below the cost estimate {js_num(est)}, 20% or more below: {clarify}" if flag else None})
        else:
            flag = F(c) < lim
            rows.append({'id': b['id'], 'evaluatedCost': c, 'belowEstimatePct': None if est is None else fl(100 * (F(est) - F(c)) / F(est)), 'flag': flag,
                         'reason': f"{b['id']}: evaluated cost {js_num(c)} is below the average {js_num(md)} less one standard deviation {js_num(sdd_print)}, that is below {js_num(md - sdd_print)}: {clarify}" if flag else None})
    return {'approach': approach, 'count': n, 'mean': mean, 'standardDeviation': sd, 'limit': limit, 'bids': rows,
            'flagged': [r['id'] for r in rows if r['flag']]}


# ------------------------------------------------------------------ whole tender
def evaluate_tender(a, descriptions):
    award = a.get('award')
    if award not in ('lowest-cost', 'combined'):
        return refuse('award', "must be 'lowest-cost' or 'combined'; there is no default")
    if 'nigerianContent' in a and award == 'combined':
        return refuse('nigerianContent', "applies s.14 at the commercial stage of a lowest-cost award; with award 'combined' state Nigerian content as a rated criterion with its weight instead")
    bids = a['bids']
    tech = technical({'criteria': a['criteria'], 'passMark': a['passMark'],
                      'bids': [{k: v for k, v in b.items() if k in ('id', 'mandatory', 'scores')} for b in bids]})
    if tech.get('error'):
        return tech
    excluded = list(tech['excluded'])
    opened = [b for b in bids if b['id'] in tech['passed']]
    if not opened:
        return {'technical': tech, 'commercial': None, 'ranking': None, 'contentPreference': None, 'award': None, 'excluded': excluded,
                'reason': 'no bid passed the technical envelope; no commercial envelope is opened'}
    ec_args = {'bids': [{k: v for k, v in b.items() if k not in ('scores', 'mandatory', 'ncPct', 'indigenous', 'capacity')} for b in opened],
               'omissionRule': a.get('omissionRule')}
    for k in ('bestEstimates', 'schedule', 'lifeCycle'):
        if k in a:
            ec_args[k] = a[k]
    com = evaluated_costs(ec_args)
    if com.get('error'):
        return com
    excluded += com['excluded']
    if not com['bids']:
        return {'technical': tech, 'commercial': com, 'ranking': None, 'contentPreference': None, 'award': None, 'excluded': excluded,
                'reason': 'every opened bid was rejected at the commercial stage'}
    tp = {r['id']: r['technicalPercent'] for r in tech['bids']}
    ranking = pref = None
    if award == 'combined':
        ranking = rank_tender({'technicalWeight': a.get('technicalWeight'), 'priceMethod': a.get('priceMethod'), 'technicalMethod': a.get('technicalMethod'),
                               'bids': [{'id': r['id'], 'technicalPercent': tp[r['id']], 'evaluatedCost': r['evaluatedCost'], 'receivedAt': r['receivedAt']} for r in com['bids']]})
        if ranking.get('error'):
            return ranking
        winner = ranking['mostAdvantageous']
        reason = f'{winner} has the highest combined score'
    else:
        winner = com['lowestEvaluatedCost']
        reason = f'{winner} has the lowest evaluated cost'
        if 'nigerianContent' in a:
            by = {b['id']: b for b in bids}
            pref = content_preference({'ncLeadBasis': a['nigerianContent'].get('ncLeadBasis'),
                                       'bids': [dict({'id': r['id'], 'evaluatedCost': r['evaluatedCost'], 'receivedAt': r['receivedAt'], 'ncPct': by[r['id']]['ncPct']},
                                                     **{k: by[r['id']][k] for k in ('indigenous', 'capacity') if k in by[r['id']]}) for r in com['bids']]})
            if pref.get('error'):
                return pref
            winner = pref['selected']
            if pref['section14']['applied'] and winner != com['lowestEvaluatedCost']:
                reason = pref['section14']['reason']
    return {'technical': tech, 'commercial': com, 'ranking': ranking, 'contentPreference': pref, 'award': winner, 'excluded': excluded, 'reason': reason}


# ================================================================== cases
def load(name):
    with open(os.path.join(FIX, name)) as f:
        return json.load(f)


DESCRIPTIONS = {
    'steel-plates-flat-sheets-sections': 'Steel plates, Flat Sheets, Sections', 'steel-pipes': 'Steel Pipes',
    'low-voltage-cables': 'Low Voltage Cables', 'high-voltage-cables': 'High Voltage Cables', 'valves': 'Valves',
    'drilling-mud-baryte-bentonite': 'Drilling mud-Baryte, Bentonite', 'cement-portland': 'Cement (Portland)',
    'cement-hydraulic': 'Cement (Hydraulic)', 'heat-exchangers': 'Heat exchangers', 'steel-ropes': 'Steel Ropes',
    'protective-paints': 'Protective paints', 'gre-pipes': 'Glass Reinforced Epoxy (GRE) pipes',
    'reservoir-services': 'Reservoir Services',
    'well-completion-services': 'Well completion services (permanent gauges and intelligent wells)',
    'wireline-services': 'Wire line services (electric open holes, electric cased hole, slick line)',
    'lwd-services': 'Logging While Drilling (LWD) services',
    'mwd-services': 'Measurement While Drilling (MWD) (direction and inclination/Gamma ray)',
    'production-drilling-service': 'Production drilling service', 'performance-services-t-and-p': 'Performance services (T and P)',
    'well-overhauling-stimulation-services': 'Well Overhauling/Stimulation Services', 'wellhead-services': 'Wellhead Services',
    'directional-surveying-services': 'Directional Surveying Services',
    'cutting-injection-disposal-services': 'Cutting Injections/Cutting Disposal Services',
    'cased-hole-logging-services': 'Cased Hole Logging Services (Gyro, Perforation, Gauges, PLT)',
    'well-watch-services': 'Well Watch Services', 'cement-service': 'Cement service', 'coiled-tubing-services': 'Coiled Tubing Services',
    'pumping-services': 'Pumping Services', 'fluid-bottom-hole-sampling-services': 'Fluid/Bottom Hole Sampling Services',
    'octg-services': 'OCTS Services (Cleaning, hard banding, recutting, rethreading, storage)',
    'well-crisis-management-services': 'Well Crisis Management Services', 'directional-drilling-services': 'Directional Drilling Services',
    'other-drilling-services': 'Other Drilling Services', 'rental-of-drill-pipe': 'Rental of Drill Pipe',
    'well-head-safety-panels': 'Well head Safety panels', 'chemicals-drilling-process-maintenance': 'CHEMICAL: Drilling, process, Maintenance',
    'mud-logging-services': 'Mud logging services', 'coring-services': 'Coring services', 'well-testing-service': 'Well Testing Service',
    'drilling-rigs-swamp': 'Drilling rigs (Swamp)', 'drilling-rigs-offshore': 'Drilling Rigs (Semi submersibles/Jack ups/Others)',
    'drilling-rigs-land': 'Drilling Rigs (Land)', 'work-over-rigs-swamp': 'Work-over Rigs (Swamp)', 'snubbing-services': 'Snubbing Services',
    'liner-float-hangers-running-equipment': 'Liner Float, Hangers and Running Equipment Services',
}

FNS = {
    'weightingBand': weighting_band,
    'correctArithmetic': correct_arithmetic,
    'technicalEvaluation': technical,
    'evaluatedCosts': evaluated_costs,
    'rankTender': rank_tender,
    'nigerianContent': lambda a: nigerian_content(a, DESCRIPTIONS),
    'contentPreference': content_preference,
    'contractTypes': contract_types,
    'shouldCost': should_cost,
    'abnormallyLow': abnormally_low,
    'evaluateTender': lambda a: evaluate_tender(a, DESCRIPTIONS),
}

CASES = []


def case(cid, fn, args, tol=1e-12, **extra):
    exp = FNS[fn](json.loads(json.dumps(args)))
    c = {'id': cid, 'fn': fn, 'args': args, 'expected': exp, 'tol': tol}
    c.update(extra)
    CASES.append(c)
    return exp


def strip(b, drop=('name', 'nc', 'ncWeights')):
    return {k: v for k, v in b.items() if k not in drop}


def build():
    ws = load('well-services.json')
    ms = load('materials.json')
    R = '2027-01-01T00:00:00Z'

    # ---- weighting band (WB Reg 5.50)
    case('band-a-high-risk-high-value', 'weightingBand', {'risk': 'high', 'estimatedCostUsd': 25000000})
    case('band-b-high-risk-low-value', 'weightingBand', {'risk': 'high', 'estimatedCostUsd': 900000, 'technicalWeight': 0.7})
    case('band-c-low-risk-high-value-at-10m', 'weightingBand', {'risk': 'low', 'estimatedCostUsd': 10000000, 'technicalWeight': 0.4})
    case('band-d-low-risk-just-below-10m', 'weightingBand', {'risk': 'low', 'estimatedCostUsd': 9999999.99, 'technicalWeight': 0.4})
    case('band-a-edge-inside-0.5', 'weightingBand', {'risk': 'high', 'estimatedCostUsd': 12000000, 'technicalWeight': 0.5})
    case('band-refuse-risk', 'weightingBand', {'risk': 'medium', 'estimatedCostUsd': 1})
    case('band-refuse-cost', 'weightingBand', {'risk': 'low', 'estimatedCostUsd': -1})
    case('band-refuse-weight', 'weightingBand', {'risk': 'low', 'estimatedCostUsd': 1, 'technicalWeight': 1.5})

    # ---- arithmetic (ITB 35.1)
    for b in ws['bids']:
        case(f'ws-arith-{b["id"]}', 'correctArithmetic', {'lines': b['lines']})
    case('arith-gap-equal-to-tolerance-not-corrected', 'correctArithmetic', {'lines': [{'id': 'x', 'quantity': 2, 'unitRate': 10.25, 'quotedAmount': 20}], 'tolerance': 0.5})
    case('arith-gap-above-tolerance-corrected', 'correctArithmetic', {'lines': [{'id': 'x', 'quantity': 2, 'unitRate': 10.25, 'quotedAmount': 19.75}], 'tolerance': 0.5})
    case('arith-quoted-total-mismatch', 'correctArithmetic', {'lines': [{'id': 'a', 'quantity': 3, 'unitRate': 100, 'quotedAmount': 300}, {'id': 'b', 'quantity': 1, 'unitRate': 50, 'quotedAmount': 50}], 'quotedTotal': 330})
    case('arith-decimal-flag-without-discrepancy', 'correctArithmetic', {'lines': [{'id': 'a', 'quantity': 4, 'unitRate': 25, 'quotedAmount': 100, 'decimalMisplaced': True}]})
    case('arith-refuse-negative-rate', 'correctArithmetic', {'lines': [{'id': 'a', 'quantity': 1, 'unitRate': -1, 'quotedAmount': 1}]})
    case('arith-refuse-decimal-zero-quantity', 'correctArithmetic', {'lines': [{'id': 'a', 'quantity': 0, 'unitRate': 1, 'quotedAmount': 5, 'decimalMisplaced': True}]})
    case('arith-refuse-duplicate-id', 'correctArithmetic', {'lines': [{'id': 'a', 'quantity': 1, 'unitRate': 1, 'quotedAmount': 1}, {'id': 'a', 'quantity': 1, 'unitRate': 1, 'quotedAmount': 1}]})
    case('arith-refuse-empty', 'correctArithmetic', {'lines': []})
    case('arith-refuse-tolerance', 'correctArithmetic', {'lines': [{'id': 'a', 'quantity': 1, 'unitRate': 1, 'quotedAmount': 1}], 'tolerance': -0.1})

    # ---- technical envelope
    tbids = lambda t: [{'id': b['id'], 'mandatory': b['mandatory'], 'scores': b['scores']} for b in t['bids']]
    crit = lambda t: [{k: c[k] for k in ('id', 'weight', 'maxScore')} for c in t['criteria']]
    ws_tech = case('ws-technical', 'technicalEvaluation', {'criteria': crit(ws), 'passMark': ws['passMark'], 'bids': tbids(ws)})
    ms_tech = case('ms-technical', 'technicalEvaluation', {'criteria': crit(ms), 'passMark': ms['passMark'], 'bids': tbids(ms)})
    case('tech-pass-mark-0', 'technicalEvaluation', {'criteria': crit(ws), 'passMark': 0, 'bids': tbids(ws)[:5]})
    case('tech-pass-mark-100', 'technicalEvaluation', {'criteria': crit(ws), 'passMark': 100, 'bids': [{'id': 'X', 'scores': {c['id']: 4 for c in ws['criteria']}}, {'id': 'Y', 'scores': {c['id']: 3.99 if c['id'] == 'schedule' else 4 for c in ws['criteria']}}]})
    case('tech-two-mandatory-failures', 'technicalEvaluation', {'criteria': crit(ws), 'passMark': 70, 'bids': [{'id': 'Z', 'mandatory': [{'id': 'bid-security', 'met': False}, {'id': 'signed-bid-form', 'met': False}], 'scores': {c['id']: 4 for c in ws['criteria']}}]})
    case('tech-refuse-weights-99', 'technicalEvaluation', {'criteria': [{'id': 'a', 'weight': 60, 'maxScore': 4}, {'id': 'b', 'weight': 39, 'maxScore': 4}], 'passMark': 50, 'bids': [{'id': 'X', 'scores': {'a': 1, 'b': 1}}]})
    case('tech-refuse-zero-weight', 'technicalEvaluation', {'criteria': [{'id': 'a', 'weight': 100, 'maxScore': 4}, {'id': 'b', 'weight': 0, 'maxScore': 4}], 'passMark': 50, 'bids': [{'id': 'X', 'scores': {'a': 1, 'b': 1}}]})
    case('tech-refuse-no-pass-mark', 'technicalEvaluation', {'criteria': crit(ws), 'bids': tbids(ws)})
    case('tech-refuse-score-above-max', 'technicalEvaluation', {'criteria': crit(ws), 'passMark': 70, 'bids': [{'id': 'X', 'scores': {c['id']: 5 for c in ws['criteria']}}]})
    case('tech-refuse-missing-score', 'technicalEvaluation', {'criteria': crit(ws), 'passMark': 70, 'bids': [{'id': 'X', 'scores': {'methodology': 3}}]})
    case('tech-refuse-mandatory-shape', 'technicalEvaluation', {'criteria': crit(ws), 'passMark': 70, 'bids': [{'id': 'X', 'mandatory': [{'id': 'a', 'met': 'yes'}], 'scores': {c['id']: 3 for c in ws['criteria']}}]})

    # ---- evaluated costs
    def ec_bids(t, passed):
        return [strip(b, ('name', 'nc', 'ncWeights', 'scores', 'mandatory', 'indigenous', 'capacity')) for b in t['bids'] if b['id'] in passed]
    ws_ec = {'bids': ec_bids(ws, ws_tech['passed']), 'omissionRule': 'average', 'schedule': ws['schedule']}
    ws_ev = case('ws-evaluated-average', 'evaluatedCosts', ws_ec)
    case('ws-evaluated-highest', 'evaluatedCosts', dict(ws_ec, omissionRule='highest'))
    ms_ec = {'bids': ec_bids(ms, ms_tech['passed']), 'omissionRule': 'average', 'schedule': ms['schedule'], 'lifeCycle': ms['lifeCycle']}
    ms_ev = case('ms-evaluated-average', 'evaluatedCosts', ms_ec)
    ms_ev_h = case('ms-evaluated-highest', 'evaluatedCosts', dict(ms_ec, omissionRule='highest'))
    case('ms-evaluated-no-life-cycle', 'evaluatedCosts', {k: v for k, v in ms_ec.items() if k != 'lifeCycle'})
    L = lambda i, q, r: {'id': i, 'quantity': q, 'unitRate': r, 'quotedAmount': q * r}
    sched = {'minWeeks': 4, 'maxWeeks': 8, 'ratePerWeek': 0.01}
    case('ec-schedule-boundaries', 'evaluatedCosts', {'omissionRule': 'average', 'schedule': sched, 'bids': [
        {'id': 'AT-MAX', 'receivedAt': R, 'lines': [L('a', 1, 1000)], 'completionWeeks': 8},
        {'id': 'BEYOND', 'receivedAt': R, 'lines': [L('a', 1, 900)], 'completionWeeks': 8.5},
        {'id': 'EARLY', 'receivedAt': R, 'lines': [L('a', 1, 1050)], 'completionWeeks': 3},
        {'id': 'AT-MIN', 'receivedAt': R, 'lines': [L('a', 1, 1040)], 'completionWeeks': 4}]})
    case('ec-best-estimate', 'evaluatedCosts', {'omissionRule': 'average', 'bestEstimates': {'b': 250}, 'bids': [
        {'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 1000)], 'omitted': ['b']},
        {'id': 'Q', 'receivedAt': R, 'lines': [L('a', 1, 1100)], 'omitted': ['b']}]})
    case('ec-rejected-bid-prices-no-omission', 'evaluatedCosts', {'omissionRule': 'highest', 'bids': [
        {'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 1000)], 'omitted': ['b']},
        {'id': 'Q', 'receivedAt': R, 'lines': [L('a', 1, 900), L('b', 1, 400)], 'rejected': 'bid security missing'},
        {'id': 'S', 'receivedAt': R, 'lines': [L('a', 1, 950), L('b', 1, 150)]}]})
    case('ec-life-cycle-residual', 'evaluatedCosts', {'omissionRule': 'average', 'lifeCycle': {'years': 3, 'discountRate': 0.08}, 'bids': [
        {'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 10000)], 'annualCosts': [1000, 1000, 1000], 'residualValue': 2500},
        {'id': 'Q', 'receivedAt': R, 'lines': [L('a', 1, 9000)], 'annualCosts': [2000, 2000, 2000]}]})
    case('ec-tie-to-receipt-then-id', 'evaluatedCosts', {'omissionRule': 'average', 'bids': [
        {'id': 'C', 'receivedAt': '2027-01-02T08:00:00Z', 'lines': [L('a', 1, 1000)]},
        {'id': 'B', 'receivedAt': '2027-01-01T08:00:00Z', 'lines': [L('a', 1, 1000)]},
        {'id': 'A', 'receivedAt': '2027-01-02T08:00:00Z', 'lines': [L('a', 1, 1000)]},
        {'id': 'D', 'receivedAt': '2027-01-01T08:00:00Z', 'lines': [L('a', 1, 999.99)]}]})
    case('ec-tie-at-12-digits', 'evaluatedCosts', {'omissionRule': 'average', 'bids': [
        {'id': 'B', 'receivedAt': R, 'lines': [L('a', 1, 1000000.0000001)]},
        {'id': 'A', 'receivedAt': R, 'lines': [L('a', 1, 1000000)]}]})
    for cid, args in [
        ('ec-refuse-no-omission-rule', {'bids': ws_ec['bids']}),
        ('ec-refuse-omission-rule-lowest', {'bids': ws_ec['bids'], 'omissionRule': 'lowest'}),
        ('ec-refuse-no-best-estimate', {'omissionRule': 'average', 'bids': [{'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 1)], 'omitted': ['z']}]}),
        ('ec-refuse-omitted-and-priced', {'omissionRule': 'average', 'bids': [{'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 1)], 'omitted': ['a']}]}),
        ('ec-refuse-received-format', {'omissionRule': 'average', 'bids': [{'id': 'P', 'receivedAt': '2027-01-01 10:00', 'lines': [L('a', 1, 1)]}]}),
        ('ec-refuse-no-weeks', {'omissionRule': 'average', 'schedule': sched, 'bids': [{'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 1)]}]}),
        ('ec-refuse-schedule-max-below-min', {'omissionRule': 'average', 'schedule': {'minWeeks': 5, 'maxWeeks': 4, 'ratePerWeek': 0.01}, 'bids': [{'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 1)], 'completionWeeks': 4}]}),
        ('ec-refuse-annual-costs-length', {'omissionRule': 'average', 'lifeCycle': {'years': 3, 'discountRate': 0.1}, 'bids': [{'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 1)], 'annualCosts': [1, 2]}]}),
        ('ec-refuse-years', {'omissionRule': 'average', 'lifeCycle': {'years': 0, 'discountRate': 0.1}, 'bids': [{'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 1)], 'annualCosts': []}]}),
        ('ec-refuse-deviation-shape', {'omissionRule': 'average', 'bids': [{'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 1)], 'deviations': [{'id': 'd', 'amount': 'ten', 'reason': 'x'}]}]}),
        ('ec-refuse-discount', {'omissionRule': 'average', 'bids': [{'id': 'P', 'receivedAt': R, 'lines': [L('a', 1, 1)], 'discount': -5}]}),
    ]:
        case(cid, 'evaluatedCosts', args)

    # ---- combined score
    tp = {r['id']: r['technicalPercent'] for r in ws_tech['bids']}
    rb = [{'id': r['id'], 'technicalPercent': tp[r['id']], 'evaluatedCost': r['evaluatedCost'], 'receivedAt': r['receivedAt']} for r in ws_ev['bids']]
    aw = ws['award']
    case('ws-rank-combined', 'rankTender', {'bids': rb, 'technicalWeight': aw['technicalWeight'], 'priceMethod': aw['priceMethod'], 'technicalMethod': aw['technicalMethod']})
    for pm in ('linear', 'mean-deviation'):
        case(f'ws-rank-{pm}', 'rankTender', {'bids': rb, 'technicalWeight': 0.7, 'priceMethod': pm, 'technicalMethod': 'relative'})
    case('ws-rank-absolute', 'rankTender', {'bids': rb, 'technicalWeight': 0.7, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'absolute'})
    case('ws-rank-price-only', 'rankTender', {'bids': rb, 'technicalWeight': 0, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'relative'})
    case('ws-rank-technical-only', 'rankTender', {'bids': rb, 'technicalWeight': 1, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'relative'})
    case('ws-rank-in-band-weight-0.6', 'rankTender', {'bids': rb, 'technicalWeight': 0.6, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'relative'})
    case('rank-linear-all-equal', 'rankTender', {'technicalWeight': 0.5, 'priceMethod': 'linear', 'technicalMethod': 'relative', 'bids': [
        {'id': 'A', 'technicalPercent': 80, 'evaluatedCost': 500, 'receivedAt': R}, {'id': 'B', 'technicalPercent': 60, 'evaluatedCost': 500, 'receivedAt': R}]})
    case('rank-mean-deviation-floor-0', 'rankTender', {'technicalWeight': 0, 'priceMethod': 'mean-deviation', 'technicalMethod': 'absolute', 'bids': [
        {'id': 'A', 'technicalPercent': 80, 'evaluatedCost': 100, 'receivedAt': R}, {'id': 'B', 'technicalPercent': 80, 'evaluatedCost': 110, 'receivedAt': R},
        {'id': 'C', 'technicalPercent': 80, 'evaluatedCost': 1000, 'receivedAt': R}]})
    case('rank-tie-broken-by-lower-cost', 'rankTender', {'technicalWeight': 0.5, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'absolute', 'bids': [
        {'id': 'A', 'technicalPercent': 100, 'evaluatedCost': 2000, 'receivedAt': R}, {'id': 'B', 'technicalPercent': 50, 'evaluatedCost': 1000, 'receivedAt': R},
        {'id': 'C', 'technicalPercent': 0, 'evaluatedCost': 500, 'receivedAt': R}]})
    case('rank-tie-broken-by-receipt-then-id', 'rankTender', {'technicalWeight': 0.5, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'absolute', 'bids': [
        {'id': 'B', 'technicalPercent': 80, 'evaluatedCost': 1000, 'receivedAt': '2027-01-01T09:00:00Z'},
        {'id': 'C', 'technicalPercent': 80, 'evaluatedCost': 1000, 'receivedAt': '2027-01-01T08:00:00Z'},
        {'id': 'A', 'technicalPercent': 80, 'evaluatedCost': 1000, 'receivedAt': '2027-01-01T09:00:00Z'}]})
    for cid, args in [
        ('rank-refuse-no-weight', {'bids': rb, 'priceMethod': 'linear', 'technicalMethod': 'relative'}),
        ('rank-refuse-price-method', {'bids': rb, 'technicalWeight': 0.7, 'priceMethod': 'median', 'technicalMethod': 'relative'}),
        ('rank-refuse-technical-method', {'bids': rb, 'technicalWeight': 0.7, 'priceMethod': 'linear'}),
        ('rank-refuse-all-rejected', {'technicalWeight': 0.5, 'priceMethod': 'linear', 'technicalMethod': 'relative', 'bids': [{'id': 'A', 'technicalPercent': 50, 'evaluatedCost': 1, 'receivedAt': R, 'rejected': 'late'}]}),
        ('rank-refuse-thigh-zero', {'technicalWeight': 0.5, 'priceMethod': 'linear', 'technicalMethod': 'relative', 'bids': [{'id': 'A', 'technicalPercent': 0, 'evaluatedCost': 1, 'receivedAt': R}]}),
        ('rank-refuse-zero-cost', {'technicalWeight': 0.5, 'priceMethod': 'linear', 'technicalMethod': 'relative', 'bids': [{'id': 'A', 'technicalPercent': 50, 'evaluatedCost': 0, 'receivedAt': R}]}),
    ]:
        case(cid, 'rankTender', args)

    # ---- published worked examples
    wb = [('A', 190, 5200000), ('B', 200, 4999999), ('C', 205, 4400000), ('D', 240, 4800000), ('E', 145, 1100000)]
    case('wb-guidance-fig-ix-company-a', 'technicalEvaluation', {'passMark': 0, 'criteria': [
        {'id': 'effectiveness', 'weight': 50, 'maxScore': 4}, {'id': 'methodology', 'weight': 25, 'maxScore': 4},
        {'id': 'team', 'weight': 15, 'maxScore': 4}, {'id': 'sustainability', 'weight': 10, 'maxScore': 4}],
        'bids': [{'id': 'A', 'scores': {'effectiveness': 2, 'methodology': 2, 'team': 2, 'sustainability': 1}}]},
        published={'source': 'World Bank Evaluating Bids and Proposals (Feb 2025) Figure IX', 'weightedPoints': {'A': 190}})
    case('wb-guidance-fig-x-to-xii', 'rankTender', {'technicalWeight': 0.8, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'relative', 'bids': [
        dict({'id': i, 'technicalPercent': pts / 4, 'evaluatedCost': c, 'receivedAt': R}, **({'rejected': 'abnormally low bid, rejected after examination'} if i == 'E' else {})) for i, pts, c in wb]},
        published={'source': 'World Bank Evaluating Bids and Proposals (Feb 2025) Figures X, XI and XII; technical points / 4 on the SPD example 0-4 scale (only the ratio T / Thigh matters)',
                   'printedTolerance': 0.01, 'rank': ['D', 'C', 'B', 'A'],
                   'technicalWeighted': {'A': 63.33, 'B': 66.66, 'C': 68.33, 'D': 80.0},
                   'financialComparative': {'A': 84.6, 'B': 88.0, 'C': 100.0, 'D': 91.7},
                   'combined': {'A': 80.25, 'B': 84.26, 'C': 88.34, 'D': 98.34}})
    case('wb-guidance-annex-2', 'technicalEvaluation', {'passMark': 80, 'criteria': [
        {'id': 'works', 'weight': 15, 'maxScore': 15}, {'id': 'value', 'weight': 15, 'maxScore': 15}, {'id': 'approach', 'weight': 70, 'maxScore': 70}],
        'bids': [{'id': 'A', 'scores': {'works': 7, 'value': 4, 'approach': 48}}, {'id': 'B', 'scores': {'works': 12, 'value': 11, 'approach': 54}},
                 {'id': 'C', 'scores': {'works': 13, 'value': 11, 'approach': 67}}]},
        published={'source': 'World Bank Evaluating Bids and Proposals (Feb 2025) Annex 2', 'totals': {'A': 59, 'C': 91}, 'rejected': ['A', 'B'],
                   'erratum': 'the Guidance prints Company B total 82, but its printed criterion scores 12 + 11 + 54 sum to 77, below the 80 threshold; the Guidance names only A as rejected'})
    a3t = case('wb-guidance-annex-3-technical', 'technicalEvaluation', {'passMark': 0, 'criteria': [
        {'id': 'effectiveness', 'weight': 50, 'maxScore': 4}, {'id': 'methodology', 'weight': 25, 'maxScore': 4},
        {'id': 'team', 'weight': 15, 'maxScore': 4}, {'id': 'sustainability', 'weight': 10, 'maxScore': 4}],
        'bids': [{'id': 'A', 'scores': {'effectiveness': 3, 'methodology': 2, 'team': 2, 'sustainability': 1}},
                 {'id': 'B', 'scores': {'effectiveness': 2, 'methodology': 2, 'team': 2, 'sustainability': 1}}]},
        published={'source': 'World Bank Evaluating Bids and Proposals (Feb 2025) Annex 3', 'weightedPoints': {'A': 240, 'B': 190}})
    case('wb-guidance-annex-3-combined', 'rankTender', {'technicalWeight': 0.4, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'relative', 'bids': [
        {'id': 'A', 'technicalPercent': a3t['bids'][0]['technicalPercent'], 'evaluatedCost': 8000000, 'receivedAt': R},
        {'id': 'B', 'technicalPercent': a3t['bids'][1]['technicalPercent'], 'evaluatedCost': 7250000, 'receivedAt': R}]},
        published={'source': 'World Bank Evaluating Bids and Proposals (Feb 2025) Annex 3', 'printedTolerance': 0.01, 'rank': ['A', 'B'],
                   'combined': {'A': 94.37, 'B': 91.66}})
    case('kiiver-kodym-2015-table-1', 'rankTender', {'technicalWeight': 0, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'absolute', 'bids': [
        {'id': 'A', 'technicalPercent': 50, 'evaluatedCost': 50, 'receivedAt': R}, {'id': 'B', 'technicalPercent': 50, 'evaluatedCost': 75, 'receivedAt': R},
        {'id': 'C', 'technicalPercent': 50, 'evaluatedCost': 100, 'receivedAt': R}]},
        published={'source': 'Kiiver and Kodym (2015) Journal of Public Procurement 15(3) Table 1', 'printedTolerance': 0.5,
                   'commercial': {'A': 100, 'B': 67, 'C': 50}})
    case('kiiver-kodym-2015-linear', 'rankTender', {'technicalWeight': 0, 'priceMethod': 'linear', 'technicalMethod': 'absolute', 'bids': [
        {'id': 'A', 'technicalPercent': 50, 'evaluatedCost': 50, 'receivedAt': R}, {'id': 'B', 'technicalPercent': 50, 'evaluatedCost': 75, 'receivedAt': R},
        {'id': 'C', 'technicalPercent': 50, 'evaluatedCost': 100, 'receivedAt': R}]})
    chen = [('A', 40), ('B', 50), ('C', 80)]
    case('chen-2008-price-formula', 'rankTender', {'technicalWeight': 0.5, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'absolute', 'bids': [
        {'id': i, 'technicalPercent': 0, 'evaluatedCost': c, 'receivedAt': R} for i, c in chen]},
        published={'source': 'Chen (2008) Journal of Public Procurement 8(3) p.409: Score = 50 x L / P', 'printedTolerance': 0, 'combined': {'A': 50, 'B': 40, 'C': 25}})
    case('chen-2008-price-formula-a-invalid', 'rankTender', {'technicalWeight': 0.5, 'priceMethod': 'lowest-ratio', 'technicalMethod': 'absolute', 'bids': [
        dict({'id': i, 'technicalPercent': 0, 'evaluatedCost': c, 'receivedAt': R}, **({'rejected': 'declared invalid after opening'} if i == 'A' else {})) for i, c in chen]},
        published={'source': 'Chen (2008) Journal of Public Procurement 8(3) p.409', 'printedTolerance': 0, 'combined': {'B': 50, 'C': 31.25}})

    # ---- Nigerian content
    ncb = lambda t: [dict({'id': b['id'], 'items': b['nc']}, **({'weights': b['ncWeights']} if 'ncWeights' in b else {})) for b in t['bids']]
    ws_nc = case('ws-nigerian-content', 'nigerianContent', {'items': ws['nc']['items'], 'bids': ncb(ws)})
    ms_nc = case('ms-nigerian-content', 'nigerianContent', {'items': ms['nc']['items'], 'bids': ncb(ms)})
    mh = lambda n, t: {'measure': 'man-hours', 'nigerian': n, 'total': t}
    case('nc-user-target-and-exact-minimum', 'nigerianContent', {'items': [
        {'id': 'rig', 'scheduleLine': 'drilling-rigs-land'}, {'id': 'catering', 'targetPct': 100, 'measure': 'man-hours', 'source': 'Board-set level for this project item under s.11(2) (hypothetical)'}],
        'bids': [{'id': 'P', 'items': {'rig': mh(7000, 10000), 'catering': mh(2000, 2000)}}, {'id': 'Q', 'items': {'rig': mh(6999, 10000), 'catering': mh(1999, 2000)}}]})
    for cid, args in [
        ('nc-refuse-measure-mismatch', {'items': [{'id': 'ct', 'scheduleLine': 'coiled-tubing-services'}], 'bids': [{'id': 'P', 'items': {'ct': {'measure': 'spend', 'nigerian': 1, 'total': 2}}}]}),
        ('nc-refuse-unknown-line', {'items': [{'id': 'x', 'scheduleLine': 'catering'}], 'bids': [{'id': 'P', 'items': {}}]}),
        ('nc-refuse-user-target-without-source', {'items': [{'id': 'x', 'targetPct': 50, 'measure': 'spend'}], 'bids': [{'id': 'P', 'items': {}}]}),
        ('nc-refuse-weights-required', {'items': ms['nc']['items'], 'bids': [{'id': b['id'], 'items': b['nc']} for b in ms['bids']]}),
        ('nc-refuse-nigerian-above-total', {'items': [{'id': 'ct', 'scheduleLine': 'coiled-tubing-services'}], 'bids': [{'id': 'P', 'items': {'ct': mh(11, 10)}}]}),
        ('nc-refuse-missing-item', {'items': ws['nc']['items'], 'bids': [{'id': 'P', 'items': {'coiled-tubing': mh(1, 2)}}]}),
        ('nc-refuse-measure-unknown', {'items': [{'id': 'x', 'targetPct': 50, 'measure': 'barrels', 'source': 's'}], 'bids': [{'id': 'P', 'items': {}}]}),
    ]:
        case(cid, 'nigerianContent', args)

    # ---- s.14 and s.16
    ncpct = {r['id']: r['ncPct'] for r in ms_nc['bids']}
    ind = {b['id']: b['indigenous'] for b in ms['bids']}
    for label, ev in (('average', ms_ev), ('highest', ms_ev_h)):
        pb = [{'id': r['id'], 'evaluatedCost': r['evaluatedCost'], 'receivedAt': r['receivedAt'], 'ncPct': ncpct[r['id']], 'indigenous': ind[r['id']], 'capacity': True} for r in ev['bids']]
        for basis in ('points', 'relative'):
            case(f'ms-preference-{label}-{basis}', 'contentPreference', {'ncLeadBasis': basis, 'bids': pb})
    P = lambda i, c, n, **k: dict({'id': i, 'evaluatedCost': c, 'ncPct': n, 'receivedAt': R}, **k)
    case('s14-group-edge-1pct-in', 'contentPreference', {'ncLeadBasis': 'points', 'bids': [P('LOW', 1000000, 60), P('EDGE', 1010000, 65)]})
    case('s14-group-edge-just-out', 'contentPreference', {'ncLeadBasis': 'points', 'bids': [P('LOW', 1000000, 60), P('OUT', 1010001, 90)]})
    case('s14-lead-exactly-5-points', 'contentPreference', {'ncLeadBasis': 'points', 'bids': [P('LOW', 1000000, 80), P('HI', 1005000, 85)]})
    case('s14-lead-4-points-relative-exactly-5pct', 'contentPreference', {'ncLeadBasis': 'relative', 'bids': [P('LOW', 1000000, 80), P('HI', 1005000, 84)]})
    case('s14-lead-4-points-read-as-points', 'contentPreference', {'ncLeadBasis': 'points', 'bids': [P('LOW', 1000000, 80), P('HI', 1005000, 84)]})
    case('s14-tied-highest-content', 'contentPreference', {'ncLeadBasis': 'points', 'bids': [P('LOW', 1000000, 50), P('M', 1004000, 70), P('N', 1008000, 70)]})
    case('s14-runner-up-zero-relative', 'contentPreference', {'ncLeadBasis': 'relative', 'bids': [P('LOW', 1000000, 0), P('HI', 1002000, 30)]})
    case('s14-lowest-also-leads', 'contentPreference', {'ncLeadBasis': 'points', 'bids': [P('LOW', 1000000, 90), P('M', 1003000, 70), P('N', 1009000, 72)]})
    case('s16-exactly-10pct', 'contentPreference', {'ncLeadBasis': 'points', 'bids': [P('LOW', 1000000, 40), P('IND', 1100000, 95, indigenous=True, capacity=True),
                                                                                    P('IND2', 1100001, 95, indigenous=True, capacity=True), P('NOCAP', 1050000, 95, indigenous=True, capacity=False)]})
    for cid, args in [
        ('pref-refuse-no-basis', {'bids': [P('A', 1, 1)]}),
        ('pref-refuse-nc-range', {'ncLeadBasis': 'points', 'bids': [P('A', 1, 101)]}),
        ('pref-refuse-indigenous-type', {'ncLeadBasis': 'points', 'bids': [P('A', 1, 1, indigenous='yes')]}),
    ]:
        case(cid, 'contentPreference', args)

    # ---- contract types
    ct = dict(ws['contracting'])
    ct.pop('note')
    case('ws-contract-types', 'contractTypes', ct, tol=1e-9)
    case('ct-triangular-fixed-fee-plan', 'contractTypes', {'duration': {'min': 10, 'mode': 12, 'max': 20}, 'dailyCost': 40000, 'fixedCost': 100000,
                                                          'lumpSum': {'price': 700000}, 'dayRate': {'rate': 48000, 'mobilisationFee': 100000},
                                                          'reimbursable': {'fixedFee': 60000}, 'plan': {'days': 13, 'dailyCost': 40000},
                                                          'iterations': 4000, 'seed': 42}, tol=1e-9)
    case('ct-constant-everything-zero-margin-is-not-a-loss', 'contractTypes', {'duration': 10, 'dailyCost': 1000, 'lumpSum': {'price': 10000}, 'dayRate': {'rate': 1100, 'mobilisationFee': 0},
                                                    'reimbursable': {'feeFraction': 0.1}, 'iterations': 10, 'seed': 1})
    base = {'duration': 10, 'dailyCost': 1000, 'lumpSum': {'price': 1}, 'dayRate': {'rate': 1, 'mobilisationFee': 0}, 'reimbursable': {'feeFraction': 0.1}, 'iterations': 10, 'seed': 1}
    for cid, patch in [
        ('ct-refuse-no-seed', {'seed': None}), ('ct-refuse-iterations', {'iterations': 0}),
        ('ct-refuse-duration-order', {'duration': {'min': 5, 'mode': 4, 'max': 6}}), ('ct-refuse-duration-negative', {'duration': {'min': -1, 'mode': 4, 'max': 6}}),
        ('ct-refuse-both-fees', {'reimbursable': {'feeFraction': 0.1, 'fixedFee': 5}}), ('ct-refuse-no-fee', {'reimbursable': {}}),
        ('ct-refuse-day-rate', {'dayRate': {'rate': 1}}), ('ct-refuse-plan', {'plan': {'days': -1, 'dailyCost': 1}}),
    ]:
        args = dict(base, **patch)
        if patch.get('seed', 0) is None:
            args.pop('seed')
        case(cid, 'contractTypes', args)

    # ---- should-cost
    sc = ws['shouldCost']
    prog = ws['contracting']['duration']['program']
    sc_bids = [{'id': r['id'], 'evaluatedCost': r['evaluatedCost']} for r in ws_ev['bids']]
    ws4 = [b for b in ws['bids'] if b['id'] == 'WS4'][0]
    sc_bids.append({'id': 'WS4', 'evaluatedCost': sum(l['quotedAmount'] for l in ws4['lines'])})
    case('ws-should-cost', 'shouldCost', {'program': prog, 'nptFrac': sc['nptFrac'], 'items': sc['items'], 'contingencyFrac': sc['contingencyFrac'],
                                          'partners': sc['partners'], 'band': sc['band'], 'bids': sc_bids})
    flat = [{'id': 'f', 'kind': 'flat', 'durationHr': 240}]
    items = [{'id': 'spread', 'basis': 'per-day', 'rate': 10000, 'category': 'intangible'}]
    case('should-cost-band-edges', 'shouldCost', {'program': flat, 'items': items, 'band': {'low': 0.8, 'high': 1.25}, 'bids': [
        {'id': 'AT-LOW', 'evaluatedCost': 80000}, {'id': 'BELOW', 'evaluatedCost': 79999}, {'id': 'AT-HIGH', 'evaluatedCost': 125000}, {'id': 'ABOVE', 'evaluatedCost': 125001}]})
    case('should-cost-drilled-metres', 'shouldCost', {'program': [{'id': 'd', 'kind': 'drill', 'fromMdM': 0, 'toMdM': 1500, 'ropMPerHr': 25},
                                                                {'id': 'c', 'kind': 'casing', 'mdM': 1500, 'runSpeedMPerHr': 300, 'flatHr': 12}],
                                                    'nptFrac': 0.2, 'contingencyFrac': 0.05,
                                                    'items': [{'id': 'rig', 'basis': 'per-day', 'rate': 30000, 'category': 'intangible'},
                                                              {'id': 'bits', 'basis': 'per-meter', 'rate': 40, 'category': 'intangible'},
                                                              {'id': 'casing', 'basis': 'lump', 'value': 250000, 'category': 'tangible'}],
                                                    'band': {'low': 0.85, 'high': 1.15}, 'bids': [{'id': 'X', 'evaluatedCost': 450000}]})
    case('should-cost-refuse-no-band', 'shouldCost', {'program': flat, 'items': items, 'bids': [{'id': 'X', 'evaluatedCost': 1}]})
    case('should-cost-refuse-band-order', 'shouldCost', {'program': flat, 'items': items, 'band': {'low': 1.2, 'high': 1.1}, 'bids': [{'id': 'X', 'evaluatedCost': 1}]})
    case('should-cost-refuse-empty-program', 'shouldCost', {'program': [], 'items': items, 'band': {'low': 0.8, 'high': 1.2}, 'bids': [{'id': 'X', 'evaluatedCost': 1}]})

    # ---- abnormally low bids (WB ALB Guidance 2016)
    ex1 = [1145142, 1330191, 1342106, 1378232, 1462176, 1476269, 1486226, 1579100, 1613371, 1657703, 1856166, 1900885, 1912355, 2099006, 2149893, 2242001]
    case('wb-alb-annex-i-example-1-relative', 'abnormallyLow', {'estimate': 2938140000, 'bids': [{'id': f'Bid {i + 1}', 'evaluatedCost': c} for i, c in enumerate(ex1)]},
         published={'source': 'World Bank ALB Guidance (2016) Annex I Example 1', 'printedTolerance': 0.5, 'mean': 1664426, 'standardDeviation': 315975, 'limit': 1348452,
                    'flagged': ['Bid 1', 'Bid 2', 'Bid 3']})
    case('wb-alb-annex-i-example-2-absolute', 'abnormallyLow', {'estimate': 150003863, 'bids': [{'id': f'Bid {i + 1}', 'evaluatedCost': c} for i, c in enumerate([85862863, 115494160, 158012899, 165385533])]},
         published={'source': 'World Bank ALB Guidance (2016) Annex I Example 2', 'flagged': ['Bid 1', 'Bid 2'],
                    'note': 'the Guidance names Bid 1, the preferred lowest bid; Bid 2 (23.0% below the estimate) is also 20% or more below by the same rule, and Example 1 puts every bid below the limit in the risk zone'})
    case('alb-absolute-exactly-20pct', 'abnormallyLow', {'estimate': 1000000, 'bids': [{'id': 'AT', 'evaluatedCost': 800000}, {'id': 'ABOVE', 'evaluatedCost': 800001}]})
    case('alb-relative-at-the-limit-not-flagged', 'abnormallyLow', {'bids': [{'id': k, 'evaluatedCost': c} for k, c in [(f'L{i}', 90) for i in range(5)] + [(f'H{i}', 110) for i in range(5)]]})
    ws_sc = FNS['shouldCost']({'program': prog, 'nptFrac': sc['nptFrac'], 'items': sc['items'], 'contingencyFrac': sc['contingencyFrac'], 'band': sc['band'], 'bids': sc_bids})
    case('ws-alb-absolute-against-should-cost', 'abnormallyLow', {'estimate': ws_sc['estimate'], 'bids': [{'id': r['id'], 'evaluatedCost': r['evaluatedCost']} for r in ws_ev['bids']]})
    case('alb-refuse-no-estimate-under-five', 'abnormallyLow', {'bids': [{'id': 'A', 'evaluatedCost': 1}]})
    case('alb-refuse-cost', 'abnormallyLow', {'bids': [{'id': 'A', 'evaluatedCost': 0}], 'estimate': 5})

    # ---- whole tenders
    def tender_args(t, **over):
        a = {'criteria': crit(t), 'passMark': t['passMark'], 'bids': [strip(b) for b in t['bids']], 'omissionRule': t['omissionRule'], 'schedule': t['schedule']}
        if 'lifeCycle' in t:
            a['lifeCycle'] = t['lifeCycle']
        a.update(over)
        return a
    case('ws-tender-combined', 'evaluateTender', tender_args(ws, award='combined', technicalWeight=0.7, priceMethod='lowest-ratio', technicalMethod='relative'))
    case('ws-tender-lowest-cost', 'evaluateTender', tender_args(ws, award='lowest-cost'))
    ncp = {r['id']: r['ncPct'] for r in ms_nc['bids']}
    ms_nc_bids = [dict(strip(b), ncPct=ncp[b['id']]) for b in ms['bids']]
    case('ms-tender-lowest-cost', 'evaluateTender', tender_args(ms, award='lowest-cost'))
    case('ms-tender-highest-rule', 'evaluateTender', tender_args(ms, award='lowest-cost', omissionRule='highest'))
    for basis in ('points', 'relative'):
        case(f'ms-tender-content-{basis}', 'evaluateTender', tender_args(ms, award='lowest-cost', bids=ms_nc_bids, nigerianContent={'ncLeadBasis': basis}))
    case('tender-nobody-passes', 'evaluateTender', tender_args(ws, award='lowest-cost', passMark=99))
    case('tender-refuse-award', 'evaluateTender', tender_args(ws))
    case('tender-refuse-content-with-combined', 'evaluateTender', tender_args(ms, award='combined', technicalWeight=0.5, priceMethod='linear', technicalMethod='relative', nigerianContent={'ncLeadBasis': 'points'}))
    case('tender-refuse-bad-criteria', 'evaluateTender', tender_args(ws, award='lowest-cost', criteria=[{'id': 'a', 'weight': 50, 'maxScore': 4}]))


def main():
    build()
    ids = [c['id'] for c in CASES]
    if len(set(ids)) != len(ids):
        sys.exit('duplicate case ids')
    doc = {
        'module': 'tender',
        'generatedBy': 'tools/validation/supplychain/oracle_tender.py',
        'engine': 'engines/supplychain/tender.js',
        'tolerance': {'absoluteFloor': 1e-9, 'note': 'relative tol per case (1e-12, Monte Carlo 1e-9); absolute floor 1e-9 in the currency unit'},
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
