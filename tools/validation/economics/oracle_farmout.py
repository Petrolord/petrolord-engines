#!/usr/bin/env python3
"""Independent stdlib oracle for engines/economics/farmout.js (Economics EC10).

    python3 tools/validation/economics/oracle_farmout.py

Writes test-data/economics/goldens/farmout_cases.json. Reads no JavaScript and
imports nothing from the engines. Every rule is coded here from the stated
deal arithmetic (sources in FINDINGS-farmout.md), by a different road:

  money          exact Fractions of the input doubles; a figure leaves the
                 oracle as the nearest double only at the end.
  cost split     a DOLLAR LEDGER: the gross cost is cut into the promoted
                 segment and the excess (gross-cost cap), each segment given
                 its own table of who pays what fraction; the carry-amount cap
                 as the farminee's own share plus the lesser of the promote and
                 the cap.
  EMV            p x success + (1 - p) x dry hole straight from the payoffs
                 (no tree); ties are exact.
  interest       the interest times the Fraction value (no applyJV); an NPV as
                 an exact Fraction sum of c_t / (1 + r)^(t - base).
  break-evens    the promote by BISECTION on exact Fractions (200 halvings of
                 [Y, F]) for the largest share with EMV >= 0; the chance from
                 the exact Fraction formula.
  VOI            Bayes and the best action per signal directly on Fractions.
  risk           the closed-form mixture moments on Fractions; the chance of a
                 loss EXACTLY by enumerating every success/failure combination
                 (independent holdings), against which the gate checks the
                 engine's seeded Monte Carlo within a binomial band.
  consent fee    python datetime for the day counts.
  carry, back-in the EC9 oracle (oracle_jointventure.py) is the witness for
                 jointVenture.js; this oracle builds the post-deal interests
                 and hands them to it.
Figures PRINTED inside a message: money rounded to the cent, computed
percentages, probabilities and ratios to 6 decimal places, both half away
from zero with trailing zeros dropped; a value within 1e-6 of a rounding tie
stops the oracle (the engine's double could fall either side), so such a
fixture is changed, never papered over.
"""
import datetime as dt
import json
import math
import os
import sys
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import oracle_jointventure as OJ  # noqa: E402  the EC9 witness for carryRecovery and backIn

ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
FIX = os.path.join(ROOT, 'test-data', 'economics', 'ekene-farmout', 'ekene-farmout.json')
OUT = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'farmout_cases.json')
MISSING = OJ.MISSING
js, js_num, isnum, show, unit = OJ.js, OJ.js_num, OJ.isnum, OJ.show, OJ.unit
Refusal, refuse, must = OJ.Refusal, OJ.refuse, OJ.must
isobj, isint, fl = OJ.isobj, OJ.isint, OJ.fl

CAPS = {'work': 500000, 'parties': 20, 'events': 20, 'years': 100, 'signals': 10, 'positions': 10, 'holdings': 50, 'iterations': 200000, 'reserves': 10}
SUM_TOL = F(1, 10 ** 9)

# AOI Regulations 2024 reg. 19(2), (7), (8), (9)
PROCESSING_PCT, PREMIUM_PCT = 2, 5
PAY_WITHIN, GRACE, SURCHARGE_PCT_DAY, SURCHARGE_DAYS = 90, 30, F(1, 100), 90


def g(d, k):
    return d[k] if isinstance(d, dict) and k in d and d[k] is not None else MISSING


def rounded(x, places, what):
    x = F(x)
    frac = (abs(x) * 10 ** places) % 1
    if abs(frac - F(1, 2)) < F(1, 10 ** 6):
        sys.exit(f'{what} figure {float(x)} is within 1e-6 of a rounding tie at {places} places: change the fixture')
    d = (Decimal(x.numerator) / Decimal(x.denominator)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    return js_num(float(d))


def money(x):
    return rounded(x, 2, 'money')


def dec(x):
    return rounded(x, 6, 'decimal')


# ----------------------------------------------------------------- checkers
def finite(f, v):
    if not isnum(v):
        must(f, 'a finite number', v)


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
    if not (isint(v) and not isinstance(v, bool) and v >= lo):
        must(f, f'an integer at or above {lo}', v)


def one_of(f, v, opts):
    if not isinstance(v, str) or v not in opts:
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


# -------------------------------------------------------------- accepted keys
OBJ, LST = OJ.OBJ, OJ.LST
PARTY = OBJ(['id', 'name', 'participatingPct'])
FARMINEE = OBJ(['id', 'name'])
CAP = OBJ(['on', 'amount', 'overrunRule'])
PAST = OBJ(['amount', 'reimbursedPct'])
PROJECT = OBJ(['chanceOfSuccessPct', 'wellCost', 'successValue'], wellCost=OBJ(['success', 'dry']),
              successValue=OBJ(['npv', 'cashFlows', 'discountRate', 'baseYear'], cashFlows=LST(OBJ(['year', 'net']))))
DEAL = OBJ(['farmineePaysPct', 'earnedPct', 'cap', 'cashBonus', 'pastCosts', 'assignorFees'], cap=CAP, pastCosts=PAST)
SHAPES = {
    'earningObligation': OBJ(['parties', 'farmor', 'farminee', 'events', 'vesting', 'eventsCompleted', 'cashBonus', 'pastCosts'],
                             parties=LST(PARTY), farminee=FARMINEE, events=LST(OBJ(['name', 'grossCost', 'farmineePaysPct', 'earnedPct', 'cap'], cap=CAP)), pastCosts=PAST),
    'dealValue': OBJ(['parties', 'farmor', 'farminee', 'project', 'deal'], parties=LST(PARTY), farminee=FARMINEE, project=PROJECT, deal=DEAL),
    'informationValue': OBJ(['parties', 'farmor', 'farminee', 'project', 'deal', 'side', 'information'], parties=LST(PARTY), farminee=FARMINEE, project=PROJECT, deal=DEAL,
                            information=OBJ(['cost', 'signals'], signals=LST(OBJ(['label', 'likelihoodsPct'])))),
    'interestValue': OBJ(['project', 'interestPct', 'valueBasis', 'transaction'], project=PROJECT,
                         transaction=OBJ(['price', 'volumeUnit', 'reserves', 'production'], reserves=LST(OBJ(['category', 'grossVolume'])), production=OBJ(['grossRate', 'rateUnit']))),
    'riskSharing': OBJ(['positions', 'correlation', 'seed', 'iterations'],
                       positions=LST(OBJ(['name', 'holdings'], holdings=LST(OBJ(['id', 'chanceOfSuccessPct', 'successValue', 'failCost', 'successStdDev']))))),
    'consentFee': OBJ(['licence', 'transactionValue', 'valueSource', 'intraGroup', 'basis', 'ratesPct', 'payment'],
                      ratesPct=OBJ(['processingPct', 'premiumPct']), payment=OBJ(['notifiedOn', 'paidOn'])),
    'developmentCarry': OBJ(['parties', 'farmor', 'farminee', 'earnedPct', 'carriedPct', 'years', 'uplift', 'recoverFromPct', 'cap', 'discountRate', 'baseYear'],
                            parties=LST(PARTY), farminee=FARMINEE, years=LST(OBJ(['year', 'cost', 'entitlement'])), uplift=OBJ(['type', 'ratePctPerYear', 'multiplePct', 'dayBasis'])),
    'backInRight': OBJ(['parties', 'farmor', 'farminee', 'earnedPct', 'backIn'], parties=LST(PARTY), farminee=FARMINEE,
                       backIn=OBJ(['party', 'targetPct', 'costs', 'basis', 'refundableKinds', 'refundForm', 'recoverFromPct', 'years'],
                                  costs=LST(OBJ(['item', 'amount', 'kind'])), years=LST(OBJ(['year', 'entitlement'])))),
}


# ------------------------------------------------------------------- parties
def check_parties(parties, pre='parties'):
    list_of(pre, parties, CAPS['parties'])
    seen = set()
    for i, p in enumerate(parties):
        text(f'{pre}[{i}].id', g(p, 'id'))
        if g(p, 'name') is not MISSING:
            text(f'{pre}[{i}].name', p['name'])
        pct_pos(f'{pre}[{i}].participatingPct', g(p, 'participatingPct'))
        if p['id'] in seen:
            must(f'{pre}[{i}].id', 'an id no other party has', p['id'])
        seen.add(p['id'])
    total = 0.0
    for p in parties:
        total += p['participatingPct']
    if abs(F(total) - 100) > SUM_TOL:
        refuse(pre, f'must have participatingPct summing to 100; got a sum of {js(total)}')


def check_deal_parties(a):
    parties, farmor, fe = g(a, 'parties'), g(a, 'farmor'), g(a, 'farminee')
    check_parties(parties)
    pid = [p['id'] for p in parties]
    one_of('farmor', farmor, pid)
    if not isobj(fe):
        must('farminee', 'an object { id, name } for the incoming party', fe)
    text('farminee.id', g(fe, 'id'))
    if g(fe, 'name') is not MISSING:
        text('farminee.name', fe['name'])
    if fe['id'] in pid:
        must('farminee.id', f'an id no licence party has ({", ".join(pid)})', fe['id'])
    Fp = next(p['participatingPct'] for p in parties if p['id'] == farmor)
    return Fp, [p for p in parties if p['id'] != farmor]


def check_cap(cap, pre):
    if not isobj(cap):
        must(pre, 'an object { on } with on "none", "gross-cost" or "carry-amount" (no default)', cap)
    on = g(cap, 'on')
    one_of(f'{pre}.on', on, ['none', 'gross-cost', 'carry-amount'])
    amt, rule = g(cap, 'amount'), g(cap, 'overrunRule')
    if on == 'none':
        if amt is not MISSING:
            must(f'{pre}.amount', 'left out when on is "none"', amt)
        if rule is not MISSING:
            must(f'{pre}.overrunRule', 'left out when on is "none"', rule)
    elif on == 'gross-cost':
        positive(f'{pre}.amount', amt)
        one_of(f'{pre}.overrunRule', rule, ['post-deal-interests', 'farmor-side'])
    else:
        non_neg(f'{pre}.amount', amt)
        if rule is not MISSING:
            must(f'{pre}.overrunRule', 'left out when on is "carry-amount" (the farmor pays the rest of its own share)', rule)


def check_pays_earned(pre, X, Yinc, Yprev, Fp):
    pct_pos(f'{pre}.earnedPct', Yinc)
    Y = F(Yprev) + F(Yinc)
    if Y > F(Fp) + SUM_TOL:
        must(f'{pre}.earnedPct', f"at most {dec(F(Fp) - F(Yprev))}, the farmor's interest {js(Fp)} less {dec(Yprev)} already earned", Yinc)
    pct(f'{pre}.farmineePaysPct', X)
    if F(X) < Y:
        must(f'{pre}.farmineePaysPct', f'at or above {dec(Y)}, the interest the farminee holds after the event (a promote of 0 or more)', X)
    if X > Fp:
        must(f'{pre}.farmineePaysPct', f"at most {js(Fp)}, the farmor's interest before the deal (the farminee pays no other party's share)", X)


def check_past(pc, pre='pastCosts'):
    if not isobj(pc):
        must(pre, 'an object { amount, reimbursedPct } (both 0 when the deal has no reimbursement; no default)', pc)
    non_neg(f'{pre}.amount', g(pc, 'amount'))
    pct(f'{pre}.reimbursedPct', g(pc, 'reimbursedPct'))


# ------------------------------------------------------------ the dollar ledger
def split_event(C, X, Y, Fp, cap):
    """Who pays each dollar of one event. Segments of the gross cost, each with
    a table {party: fraction}; the carry-amount cap as own share + min(promote, cap)."""
    C, X, Y, Fp = F(C), F(X), F(Y), F(Fp)
    on = cap['on']
    if on == 'carry-amount':
        M = F(cap['amount'])
        promote = (X - Y) / 100 * C
        carry = min(promote, M)
        state = 'below' if promote < M else 'exactly' if promote == M else 'exceeded'
        fin = Y / 100 * C + carry
        return {'farmineePays': fin, 'farmorPays': (Fp - Y) / 100 * C - carry, 'carry': carry, 'capState': state, 'base': C, 'excess': F(0), 'carryUncapped': promote}
    if on == 'gross-cost':
        K = F(cap['amount'])
        segs = [(min(C, K), {'fin': X / 100, 'farmor': (Fp - X) / 100})]
        if C > K:
            if cap['overrunRule'] == 'post-deal-interests':
                segs.append((C - K, {'fin': Y / 100, 'farmor': (Fp - Y) / 100}))
            else:
                segs.append((C - K, {'fin': F(0), 'farmor': Fp / 100}))
        state = 'below' if C < K else 'exactly' if C == K else 'exceeded'
    else:
        segs = [(C, {'fin': X / 100, 'farmor': (Fp - X) / 100})]
        state = 'none'
    fin = sum((amt * t['fin'] for amt, t in segs), F(0))
    fp = sum((amt * t['farmor'] for amt, t in segs), F(0))
    return {'farmineePays': fin, 'farmorPays': fp, 'carry': fin - Y / 100 * C, 'capState': state, 'base': segs[0][0],
            'excess': segs[1][0] if len(segs) > 1 else F(0), 'carryUncapped': None}


def cap_reason(s, cap, C, Y, Fp, fid, farmor):
    on = cap['on']
    if on == 'none':
        return 'no cap: the promote applies to the whole gross cost'
    if on == 'gross-cost':
        if s['capState'] == 'below':
            return f'the gross cost {money(C)} is below the cap {money(cap["amount"])}: the promote applies to all of it'
        if s['capState'] == 'exactly':
            return f'the gross cost reaches the cap {money(cap["amount"])} exactly: the promote applies to all of it, with no excess'
        who = (f'by the post-deal interests ({fid} {dec(Y)}%, {farmor} {dec(F(Fp) - F(Y))}%)' if cap['overrunRule'] == 'post-deal-interests'
               else f'by the farmor side alone ({farmor} pays its whole {js(Fp)}% share of it)')
        return f'the gross cost exceeds the cap {money(cap["amount"])} by {money(s["excess"])}: the promote applies to {money(s["base"])}; the excess is paid {who}'
    if s['capState'] == 'below':
        return f'the carry {money(s["carryUncapped"])} is below the cap {money(cap["amount"])}'
    if s['capState'] == 'exactly':
        return f'the carry reaches the cap {money(cap["amount"])} exactly'
    return f'the carry {money(s["carryUncapped"])} is held at the cap {money(cap["amount"])}; {farmor} pays the rest of its {dec(F(Fp) - F(Y))}% share'


def interests_after(parties, farmor, fid, vested):
    rows = [{'id': p['id'], 'participatingPct': fl(F(p['participatingPct']) - (F(vested) if p['id'] == farmor else 0))} for p in parties]
    return rows + [{'id': fid, 'participatingPct': fl(vested)}]


def earning(a):
    Fp, others = check_deal_parties(a)
    parties, farmor, fid = a['parties'], a['farmor'], a['farminee']['id']
    events = g(a, 'events')
    list_of('events', events, CAPS['events'])
    yprev = F(0)
    seen = set()
    for i, ev in enumerate(events):
        pre = f'events[{i}]'
        text(f'{pre}.name', g(ev, 'name'))
        positive(f'{pre}.grossCost', g(ev, 'grossCost'))
        check_pays_earned(pre, g(ev, 'farmineePaysPct'), g(ev, 'earnedPct'), yprev, Fp)
        check_cap(g(ev, 'cap'), f'{pre}.cap')
        if ev['name'] in seen:
            must(f'{pre}.name', 'a name no other event has', ev['name'])
        seen.add(ev['name'])
        yprev += F(ev['earnedPct'])
    vesting, done_n, bonus, pc = g(a, 'vesting'), g(a, 'eventsCompleted'), g(a, 'cashBonus'), g(a, 'pastCosts')
    one_of('vesting', vesting, ['per-event', 'all-events'])
    int_at_least('eventsCompleted', done_n, 0)
    non_neg('cashBonus', bonus)
    check_past(pc)
    if done_n > len(events):
        must('eventsCompleted', f'at most {len(events)}, the number of events', done_n)
    reasons, rows = [], []
    Y = F(0)
    for k, ev in enumerate(events):
        yb = Y
        Y += F(ev['earnedPct'])
        C, X = F(ev['grossCost']), F(ev['farmineePaysPct'])
        s = split_event(C, X, Y, Fp, ev['cap'])
        completed = k < done_n
        eff = s['farmineePays'] * 100 / C
        reasons.append(f'{ev["name"]}: gross cost {money(C)}; {fid} pays {js(X)}% to earn {js(ev["earnedPct"])}% ({dec(Y)}% held after it): a promote of {dec(X - Y)} points, '
                       f'ratio {js(X)} / {dec(Y)}; {cap_reason(s, ev["cap"], C, Y, Fp, fid, farmor)}; {fid} pays {money(s["farmineePays"])} ({dec(eff)}% of the gross cost), '
                       f'{farmor} pays {money(s["farmorPays"])}, a carry of {money(s["carry"])}' + ('' if completed else ' (not completed: the obligation only)'))
        rows.append({'name': ev['name'], 'completed': completed, 'grossCost': ev['grossCost'], 'farmineePaysPct': ev['farmineePaysPct'], 'earnedPct': ev['earnedPct'],
                     'heldBeforePct': fl(yb), 'heldAfterPct': fl(Y), 'promotePoints': fl(X - Y), 'promoteRatio': fl(X / Y),
                     'capState': s['capState'], 'promotedCost': fl(s['base']), 'excess': fl(s['excess']),
                     'carryUncapped': None if s['carryUncapped'] is None else fl(s['carryUncapped']),
                     'farmineePays': fl(s['farmineePays']), 'farmorPays': fl(s['farmorPays']), 'carry': fl(s['carry']), 'effectivePayingPct': fl(eff),
                     'others': [{'id': o['id'], 'pays': fl(C * F(o['participatingPct']) / 100)} for o in others],
                     '_s': s})
    done = [r for r in rows if r['completed']]
    all_done = done_n == len(events)
    vested = sum((F(r['earnedPct']) for r in done), F(0)) if vesting == 'per-event' else (Y if all_done else F(0))
    if vesting == 'all-events' and not all_done:
        reasons.append(f'vesting "all-events": {done_n} of {unit(len(events), "event")} completed; nothing vests')
    elif vesting == 'per-event' and not all_done:
        reasons.append(f'vesting "per-event": {done_n} of {unit(len(events), "event")} completed; {dec(vested)}% vests')
    reimb = F(pc['amount']) * F(pc['reimbursedPct']) / 100
    gross = sum((F(r['grossCost']) for r in done), F(0))
    paid = sum((r['_s']['farmineePays'] for r in done), F(0))
    carry = sum((r['_s']['carry'] for r in done), F(0))
    outlay = paid + F(bonus) + reimb
    eqwi = outlay * 100 / gross if gross > 0 else None
    if bonus == 0:
        reasons.append('cash bonus: none (stated as 0)')
    reasons.append(f'consideration to {farmor}: carry {money(carry)} + cash bonus {money(bonus)} + past-cost reimbursement {money(reimb)} '
                   f'({js(pc["reimbursedPct"])}% of {money(pc["amount"])}) = {money(carry + F(bonus) + reimb)}')
    fpaid = sum((r['_s']['farmorPays'] for r in done), F(0))
    for r in rows:
        del r['_s']
    return {
        'farmor': farmor, 'farminee': fid, 'farmorInterestBeforePct': Fp, 'events': rows, 'vesting': vesting, 'eventsCompleted': done_n, 'vestedPct': fl(vested),
        'interestsAfter': interests_after(parties, farmor, fid, vested),
        'totals': {'grossCost': fl(gross), 'farmineePays': fl(paid), 'farmorPays': fl(fpaid),
                   'carry': fl(carry), 'cashBonus': bonus, 'pastCostReimbursement': fl(reimb), 'consideration': fl(carry + F(bonus) + reimb), 'farmineeOutlay': fl(outlay),
                   'effectivePayingPct': fl(paid * 100 / gross) if gross > 0 else None, 'equivalentWorkingInterestPct': None if eqwi is None else fl(eqwi),
                   'promoteAdjustedRatio': fl(eqwi / vested) if eqwi is not None and vested > 0 else None},
        'reasons': reasons,
    }


# ----------------------------------------------------------------- the project
def npv_exact(flows, rate, base, first):
    r = F(rate)
    return sum((F(c) / (1 + r) ** (first + i - base) for i, c in enumerate(flows)), F(0))


def check_project(pr):
    if not isobj(pr):
        must('project', 'an object { chanceOfSuccessPct, wellCost, successValue }', pr)
    pct('project.chanceOfSuccessPct', g(pr, 'chanceOfSuccessPct'))
    w = g(pr, 'wellCost')
    if not isobj(w):
        must('project.wellCost', 'an object { success, dry } of gross well costs (no default)', w)
    non_neg('project.wellCost.success', g(w, 'success'))
    non_neg('project.wellCost.dry', g(w, 'dry'))
    s = g(pr, 'successValue')
    if not isobj(s):
        must('project.successValue', 'an object { npv } or { cashFlows, discountRate, baseYear }', s)
    p = F(pr['chanceOfSuccessPct']) / 100
    if g(s, 'npv') is not MISSING:
        finite('project.successValue.npv', s['npv'])
        for k in ['cashFlows', 'discountRate', 'baseYear']:
            if g(s, k) is not MISSING:
                must(f'project.successValue.{k}', 'left out when npv is stated', s[k])
        return {'p': p, 'S': F(s['npv']), 'flows': None}
    cf = g(s, 'cashFlows')
    if cf is MISSING:
        must('project.successValue', 'an object { npv } or { cashFlows, discountRate, baseYear }', s)
    list_of('project.successValue.cashFlows', cf, CAPS['years'])
    for i, y in enumerate(cf):
        f = f'project.successValue.cashFlows[{i}]'
        int_at_least(f'{f}.year', g(y, 'year'), 1)
        finite(f'{f}.net', g(y, 'net'))
        if i > 0 and y['year'] != cf[i - 1]['year'] + 1:
            must(f'{f}.year', f'{cf[i - 1]["year"] + 1}, the year after {cf[i - 1]["year"]} (years are consecutive)', y['year'])
    r = g(s, 'discountRate')
    if not (isnum(r) and r > -1):
        must('project.successValue.discountRate', 'a finite number above -1 (a fraction: 0.1 is 10%)', r)
    int_at_least('project.successValue.baseYear', g(s, 'baseYear'), 1)
    S = npv_exact([y['net'] for y in cf], r, s['baseYear'], cf[0]['year'])
    return {'p': p, 'S': S, 'flows': s}


def check_deal(deal, Fp):
    if not isobj(deal):
        must('deal', 'an object { farmineePaysPct, earnedPct, cap, cashBonus, pastCosts, assignorFees }', deal)
    check_pays_earned('deal', g(deal, 'farmineePaysPct'), g(deal, 'earnedPct'), 0, Fp)
    check_cap(g(deal, 'cap'), 'deal.cap')
    non_neg('deal.cashBonus', g(deal, 'cashBonus'))
    check_past(g(deal, 'pastCosts'), 'deal.pastCosts')
    non_neg('deal.assignorFees', g(deal, 'assignorFees'))


def payoffs(pr, project, deal, Fp, X):
    """Positions: an interest of the success-case value (interest x value) less
    the share of each outcome's well cost from the dollar ledger."""
    Y, S = F(deal['earnedPct']), pr['S']
    Fq = F(Fp)
    ws = split_event(project['wellCost']['success'], X, Y, Fp, deal['cap'])
    wd = split_event(project['wellCost']['dry'], X, Y, Fp, deal['cap'])
    reimb = F(deal['pastCosts']['amount']) * F(deal['pastCosts']['reimbursedPct']) / 100
    cash = F(deal['cashBonus']) + reimb
    fees = F(deal['assignorFees'])
    Ws, Wd = F(project['wellCost']['success']), F(project['wellCost']['dry'])
    return {
        'ws': ws, 'wd': wd, 'reimb': reimb,
        'farmorAlone': {'success': Fq / 100 * S - Fq / 100 * Ws, 'dry': -Fq / 100 * Wd},
        'farmorFarmOut': {'success': (Fq - Y) / 100 * S - ws['farmorPays'] + cash - fees, 'dry': -wd['farmorPays'] + cash - fees},
        'farminee': {'success': Y / 100 * S - ws['farmineePays'] - cash, 'dry': -wd['farmineePays'] - cash},
    }


def emv(p, q):
    return p * q['success'] + (1 - p) * q['dry']


def best_of(pairs):
    top = max(v for _, v in pairs)
    tied = [lab for lab, v in pairs if v == top]
    return tied[0], tied


def breakeven_chance(q):
    a, b = q['success'], q['dry']
    if a >= 0 and b >= 0:
        return {'status': 'never-negative', 'chanceOfSuccessPct': None}, None
    if a <= 0 and b <= 0:
        return {'status': 'never-positive', 'chanceOfSuccessPct': None}, None
    x = -b * 100 / (a - b)
    return {'status': 'solved', 'chanceOfSuccessPct': fl(x)}, x


def breakeven_promote(pr, project, deal, Fp):
    Y, Fq, p = F(deal['earnedPct']), F(Fp), pr['p']
    f_emv = lambda x: emv(p, payoffs(pr, project, deal, Fp, x)['farminee'])  # noqa: E731
    pts = [Y, Fq]
    if deal['cap']['on'] == 'carry-amount':
        for c in [project['wellCost']['success'], project['wellCost']['dry']]:
            if c > 0:
                k = Y + 100 * F(deal['cap']['amount']) / F(c)
                if Y < k < Fq:
                    pts.append(k)
    xs = sorted(set(pts))
    bps = [{'farmineePaysPct': fl(x), 'emv': fl(f_emv(x))} for x in xs]

    def out(status, x):
        return {'status': status, 'farmineePaysPct': None if x is None else fl(x), 'promotePoints': None if x is None else fl(x - Y),
                'promoteRatio': None if x is None else fl(x / Y), 'breakpoints': bps}, x
    if f_emv(Y) < 0:
        return out('negative-without-promote', None)
    if f_emv(Fq) > 0:
        return out('positive-at-farmor-share', None)
    if f_emv(Fq) == 0:
        return out('solved', Fq)
    lo, hi = Y, Fq  # EMV(lo) >= 0 > EMV(hi)
    for _ in range(200):
        mid = (lo + hi) / 2
        if f_emv(mid) >= 0:
            lo = mid
        else:
            hi = mid
    return out('solved', lo)


def deal_core(a):
    Fp, _ = check_deal_parties(a)
    pr = check_project(g(a, 'project'))
    check_deal(g(a, 'deal'), Fp)
    return Fp, pr, payoffs(pr, a['project'], a['deal'], Fp, F(a['deal']['farmineePaysPct']))


def bc_reason(who, r, x):
    if r['status'] == 'solved':
        return f'{who}: EMV is 0 at a chance of success of {dec(x)}%'
    if r['status'] == 'never-negative':
        return f'{who}: EMV is at or above 0 at every chance of success (the dry hole is not a loss)'
    return f'{who}: EMV is below 0 at every chance of success'


def pos_out(q, e):
    return {'success': fl(q['success']), 'dry': fl(q['dry']), 'emv': fl(e)}


def deal_value(a):
    Fp, pr, po = deal_core(a)
    project, deal, farmor, fid = a['project'], a['deal'], a['farmor'], a['farminee']['id']
    p, Y, X, Fq = pr['p'], F(deal['earnedPct']), F(deal['farmineePaysPct']), F(Fp)
    e_alone, e_out, e_in = emv(p, po['farmorAlone']), emv(p, po['farmorFarmOut']), emv(p, po['farminee'])
    fbest, ftied = best_of([('drill alone', e_alone), ('farm out', e_out), ('walk away', F(0))])
    nbest, ntied = best_of([('farm in', e_in), ('decline', F(0))])
    bep, xstar = breakeven_promote(pr, project, deal, Fp)
    bcs = {k: breakeven_chance(po[k]) for k in ['farmorAlone', 'farmorFarmOut', 'farminee']}
    exp_carry = p * po['ws']['carry'] + (1 - p) * po['wd']['carry']
    cash = F(deal['cashBonus']) + po['reimb']
    flows = pr['flows']
    reasons = [
        f'success-case value at 100%: {money(pr["S"])}' + (f' (the canonical npv of the stated cash flows at {js(flows["discountRate"])} to {flows["baseYear"]})' if flows else '')
        + f'; chance of success {js(project["chanceOfSuccessPct"])}%',
        f'{farmor} alone ({js(Fp)}%): success {money(po["farmorAlone"]["success"])}, dry hole {money(po["farmorAlone"]["dry"])}, EMV {money(e_alone)}',
        f'{farmor} after the farm-out ({dec(Fq - Y)}%, paying {money(po["ws"]["farmorPays"])} of the success well and {money(po["wd"]["farmorPays"])} of the dry hole): '
        f'success {money(po["farmorFarmOut"]["success"])}, dry hole {money(po["farmorFarmOut"]["dry"])}, EMV {money(e_out)}',
        f'{fid} ({js(deal["earnedPct"])}% for {js(deal["farmineePaysPct"])}% of the well): success {money(po["farminee"]["success"])}, dry hole {money(po["farminee"]["dry"])}, EMV {money(e_in)}',
        f'{farmor}: the best action is ' + (f'a tie between {", ".join(ftied)}' if len(ftied) > 1 else fbest) + f'; {fid}: ' + (f'a tie between {", ".join(ntied)}' if len(ntied) > 1 else nbest),
    ]
    if bep['status'] == 'solved':
        reasons.append(f"break-even promote: {fid}'s EMV is 0 when it pays {dec(xstar)}% of the well for {js(deal['earnedPct'])}% (a promote of {dec(xstar - Y)} points)")
    elif bep['status'] == 'negative-without-promote':
        reasons.append(f"break-even promote: none; paying only its {js(deal['earnedPct'])}% share (no promote) {fid}'s EMV is {money(emv(p, payoffs(pr, project, deal, Fp, Y)['farminee']))}, below 0")
    else:
        reasons.append(f"break-even promote: none up to the farmor's whole {js(Fp)}% share; paying it, {fid}'s EMV is {money(emv(p, payoffs(pr, project, deal, Fp, Fq)['farminee']))}, above 0")
    reasons += [bc_reason(f'{farmor} alone', *bcs['farmorAlone']), bc_reason(f'{farmor} after the farm-out', *bcs['farmorFarmOut']), bc_reason(fid, *bcs['farminee'])]
    if deal['cashBonus'] == 0:
        reasons.append('cash bonus: none (stated as 0)')
    ws, wd = po['ws'], po['wd']
    return {
        'farmor': {'alone': pos_out(po['farmorAlone'], e_alone), 'farmOut': pos_out(po['farmorFarmOut'], e_out), 'walkAway': 0, 'bestAction': fbest, 'tiedActions': ftied},
        'farminee': fid, 'farmorInterestBeforePct': Fp, 'chanceOfSuccessPct': project['chanceOfSuccessPct'], 'successValue100': fl(pr['S']),
        'terms': {'farmineePaysPct': deal['farmineePaysPct'], 'earnedPct': deal['earnedPct'], 'promotePoints': fl(X - Y), 'promoteRatio': fl(X / Y),
                  'cashBonus': deal['cashBonus'], 'pastCostReimbursement': fl(po['reimb']), 'assignorFees': deal['assignorFees']},
        'wellCostSplit': {
            'success': {'grossCost': project['wellCost']['success'], 'farmineePays': fl(ws['farmineePays']), 'farmorPays': fl(ws['farmorPays']), 'carry': fl(ws['carry']), 'capState': ws['capState']},
            'dry': {'grossCost': project['wellCost']['dry'], 'farmineePays': fl(wd['farmineePays']), 'farmorPays': fl(wd['farmorPays']), 'carry': fl(wd['carry']), 'capState': wd['capState']},
        },
        'farmineeSide': {'farmIn': pos_out(po['farminee'], e_in), 'decline': 0, 'bestAction': nbest, 'tiedActions': ntied},
        'transfer': {'farmorAloneEmv': fl(e_alone), 'farmorFarmOutEmv': fl(e_out), 'farmineeEmv': fl(e_in), 'assignorFees': deal['assignorFees'],
                     'difference': fl(e_alone - (e_out + e_in + F(deal['assignorFees'])))},
        'breakEvenPromote': bep,
        'breakEvenChance': {k: v[0] for k, v in bcs.items()},
        'consideration': {'cashBonus': deal['cashBonus'], 'pastCostReimbursement': fl(po['reimb']), 'carrySuccess': fl(ws['carry']), 'carryDry': fl(wd['carry']),
                          'expectedCarry': fl(exp_carry), 'expectedTotal': fl(exp_carry + cash), 'perPercentEarned': fl((exp_carry + cash) / Y)},
        'reasons': reasons,
    }


# ------------------------------------------------------------ information value
def info_value(a):
    Fp, pr, po = deal_core(a)
    side, inf = g(a, 'side'), g(a, 'information')
    one_of('side', side, ['farmor', 'farminee'])
    if not isobj(inf):
        must('information', 'an object { cost, signals }', inf)
    non_neg('information.cost', g(inf, 'cost'))
    sig = g(inf, 'signals')
    list_of('information.signals', sig, CAPS['signals'])
    if len(sig) < 2:
        must('information.signals', 'an array of at least 2 signals', sig)
    for i, s in enumerate(sig):
        f = f'information.signals[{i}]'
        text(f'{f}.label', g(s, 'label'))
        lk = g(s, 'likelihoodsPct')
        if not isinstance(lk, list) or len(lk) != 2:
            must(f'{f}.likelihoodsPct', 'an array [P(signal | success), P(signal | dry hole)] in per cent', lk)
        pct(f'{f}.likelihoodsPct[0]', lk[0])
        pct(f'{f}.likelihoodsPct[1]', lk[1])
    for k in [0, 1]:
        t = 0.0
        for s in sig:
            t += s['likelihoodsPct'][k]
        if abs(F(t) - 100) > SUM_TOL:
            refuse('information.signals', f'must have likelihoodsPct[{k}] summing to 100 over the signals (P(signal | {"success" if k == 0 else "dry hole"})); got a sum of {js(t)}')
    p = pr['p']
    if side == 'farminee':
        acts = [('farm in', po['farminee']), ('decline', {'success': F(0), 'dry': F(0)})]
    else:
        acts = [('drill alone', po['farmorAlone']), ('farm out', po['farmorFarmOut']), ('walk away', {'success': F(0), 'dry': F(0)})]
    prior = max(emv(p, q) for _, q in acts)
    perfect = p * max(q['success'] for _, q in acts) + (1 - p) * max(q['dry'] for _, q in acts)
    ev = F(0)
    per = []
    for s in sig:
        ls, ld = F(s['likelihoodsPct'][0]) / 100, F(s['likelihoodsPct'][1]) / 100
        ps = p * ls + (1 - p) * ld
        post = p * ls / ps if ps > 0 else p
        vals = [(lab, emv(post, q)) for lab, q in acts]
        best, tied = best_of(vals)
        e = max(v for _, v in vals)
        ev += ps * e
        per.append({'label': s['label'], 'probability': fl(ps), 'posteriorSuccessPct': fl(post * 100), 'emv': fl(e), 'bestAction': best, 'tiedActions': tied, '_p': ps, '_q': post * 100, '_e': e})
    cost = F(inf['cost'])
    evii = ev - prior
    net = evii - cost
    reasons = [f'{side}: EMV without information {money(prior)}; with perfect information {money(perfect)}; EVPI {money(perfect - prior)}']
    for s in per:
        reasons.append(f'signal "{s["label"]}" (probability {dec(s["_p"])}): chance of success {dec(s["_q"])}%, best action '
                       + (f'a tie between {", ".join(s["tiedActions"])}' if len(s['tiedActions']) > 1 else s['bestAction']) + f', EMV {money(s["_e"])}')
    verdict = 'the information is worth buying' if net > 0 else 'the information is worth exactly its cost' if net == 0 else 'the information costs more than it is worth'
    reasons.append(f'EVII {money(evii)}; less the information cost {money(cost)}: {money(net)}; {verdict}')
    for s in per:
        for k in ['_p', '_q', '_e']:
            del s[k]
    return {'side': side, 'actions': [{'label': lab, 'success': fl(q['success']), 'dry': fl(q['dry'])} for lab, q in acts],
            'emvPrior': fl(prior), 'evWithPerfectInformation': fl(perfect), 'evpi': fl(perfect - prior), 'evWithInformation': fl(ev), 'evii': fl(evii),
            'informationCost': inf['cost'], 'netEvii': fl(net), 'perSignal': per, 'reasons': reasons}


# ------------------------------------------------------------- interest value
def interest_value(a):
    pr = check_project(g(a, 'project'))
    ip, vb, tx = g(a, 'interestPct'), g(a, 'valueBasis'), g(a, 'transaction')
    pct_pos('interestPct', ip)
    one_of('valueBasis', vb, ['risked', 'success-case'])
    if tx is not MISSING:
        if not isobj(tx):
            must('transaction', 'an object { price, volumeUnit, reserves, production } when given', tx)
        non_neg('transaction.price', g(tx, 'price'))
        if g(tx, 'reserves') is not MISSING:
            text('transaction.volumeUnit', g(tx, 'volumeUnit'))
            list_of('transaction.reserves', tx['reserves'], CAPS['reserves'])
            seen = set()
            for i, r in enumerate(tx['reserves']):
                text(f'transaction.reserves[{i}].category', g(r, 'category'))
                positive(f'transaction.reserves[{i}].grossVolume', g(r, 'grossVolume'))
                if r['category'] in seen:
                    must(f'transaction.reserves[{i}].category', 'a category no other entry names', r['category'])
                seen.add(r['category'])
        elif g(tx, 'volumeUnit') is not MISSING:
            must('transaction.volumeUnit', 'left out when no reserves are stated', tx['volumeUnit'])
        q = g(tx, 'production')
        if q is not MISSING:
            if not isobj(q):
                must('transaction.production', 'an object { grossRate, rateUnit } when given', q)
            positive('transaction.production.grossRate', g(q, 'grossRate'))
            text('transaction.production.rateUnit', g(q, 'rateUnit'))
    project = a['project']
    s100 = pr['S'] - F(project['wellCost']['success'])
    d100 = -F(project['wellCost']['dry'])
    r100 = emv(pr['p'], {'success': s100, 'dry': d100})
    base = r100 if vb == 'risked' else s100
    iv = base * F(ip) / 100
    reasons = [f'100% position: success {money(s100)} (success-case value {money(pr["S"])} less the success well cost {money(project["wellCost"]["success"])}), dry hole {money(d100)}; '
               f'risked EMV at {js(project["chanceOfSuccessPct"])}% {money(r100)}',
               f'per percent of working interest: risked {money(r100 / 100)}, success case {money(s100 / 100)}; {js(ip)}% on the {vb} basis is worth {money(iv)}']
    txo = None
    if tx is not MISSING:
        price = F(tx['price'])
        implied = price / F(ip)
        bpp = base / 100
        res = []
        for r in (tx['reserves'] if g(tx, 'reserves') is not MISSING else []):
            net = F(r['grossVolume']) * F(ip) / 100
            res.append({'category': r['category'], 'grossVolume': r['grossVolume'], 'netVolume': fl(net), 'pricePerUnit': fl(price / net), '_n': net, '_p': price / net})
        prod = None
        if g(tx, 'production') is not MISSING:
            nr = F(tx['production']['grossRate']) * F(ip) / 100
            prod = {'grossRate': tx['production']['grossRate'], 'rateUnit': tx['production']['rateUnit'], 'netRate': fl(nr), 'pricePerFlowingUnit': fl(price / nr), '_n': nr, '_p': price / nr}
        ptv = implied / bpp if bpp > 0 else None
        reasons.append(f'stated price {money(price)} for {js(ip)}%: {money(implied)} a percent, {money(implied * 100)} for 100%'
                       + (f'; no price-to-value ratio, the {vb} value per percent being {money(bpp)}, at or below 0' if ptv is None else f'; {dec(ptv)} times the {vb} value per percent'))
        for r in res:
            reasons.append(f'{r["category"]}: {dec(r["_n"])} {tx["volumeUnit"]} net to the interest; {money(r["_p"])} per {tx["volumeUnit"]}')
        if prod:
            reasons.append(f'production: {dec(prod["_n"])} {prod["rateUnit"]} net to the interest; {money(prod["_p"])} per {prod["rateUnit"]}')
            del prod['_n'], prod['_p']
        for r in res:
            del r['_n'], r['_p']
        txo = {'price': tx['price'], 'impliedPerPct': fl(implied), 'implied100': fl(implied * 100), 'priceToValue': None if ptv is None else fl(ptv),
               'volumeUnit': tx['volumeUnit'] if g(tx, 'volumeUnit') is not MISSING else None, 'reserves': res, 'production': prod}
    return {'interestPct': ip, 'valueBasis': vb, 'chanceOfSuccessPct': project['chanceOfSuccessPct'], 'successValue100': fl(pr['S']),
            'position100': {'success': fl(s100), 'dry': fl(d100), 'emv': fl(r100)}, 'perPct': {'risked': fl(r100 / 100), 'successCase': fl(s100 / 100)},
            'interestValue': fl(iv), 'transaction': txo, 'reasons': reasons}


# ---------------------------------------------------------------- risk sharing
def phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def risk(a):
    pos, rho, seed, it = g(a, 'positions'), g(a, 'correlation'), g(a, 'seed'), g(a, 'iterations')
    list_of('positions', pos, CAPS['positions'])
    if not (isnum(rho) and 0 <= rho <= 1):
        must('correlation', 'a number from 0 to 1 (the correlation of the latent drivers; stated, no default)', rho)
    if not (isint(seed) and not isinstance(seed, bool) and 0 <= seed <= 4294967295):
        must('seed', 'an integer from 0 to 4294967295 (stated; no default)', seed)
    if not (isint(it) and not isinstance(it, bool) and 1 <= it <= CAPS['iterations']):
        must('iterations', f'an integer from 1 to {CAPS["iterations"]} (stated; no default)', it)
    seenp = set()
    for i, ps in enumerate(pos):
        f = f'positions[{i}]'
        text(f'{f}.name', g(ps, 'name'))
        list_of(f'{f}.holdings', g(ps, 'holdings'), CAPS['holdings'])
        if ps['name'] in seenp:
            must(f'{f}.name', 'a name no other position has', ps['name'])
        seenp.add(ps['name'])
        seen = set()
        for k, h in enumerate(ps['holdings']):
            gg = f'{f}.holdings[{k}]'
            text(f'{gg}.id', g(h, 'id'))
            pct(f'{gg}.chanceOfSuccessPct', g(h, 'chanceOfSuccessPct'))
            finite(f'{gg}.successValue', g(h, 'successValue'))
            non_neg(f'{gg}.failCost', g(h, 'failCost'))
            non_neg(f'{gg}.successStdDev', g(h, 'successStdDev'))
            if h['id'] in seen:
                must(f'{gg}.id', 'an id no other holding in the position has', h['id'])
            seen.add(h['id'])
    nh = sum(len(ps['holdings']) for ps in pos)
    if it * nh > CAPS['work']:
        must('iterations', f'at most {CAPS["work"] // nh} for {unit(nh, "holding")} in all (iterations x holdings at most {CAPS["work"]})', it)
    rows, exact = [], []
    for ps in pos:
        mean, vsum, sdsum = F(0), F(0), 0.0
        for h in ps['holdings']:
            p, s, fc, sd = F(h['chanceOfSuccessPct']) / 100, F(h['successValue']), F(h['failCost']), F(h['successStdDev'])
            m = p * s - (1 - p) * fc
            v = max(F(0), p * (sd * sd + s * s) + (1 - p) * fc * fc - m * m)
            mean += m
            vsum += v
            sdsum += math.sqrt(v)
        var = float(vsum) + rho * max(0.0, sdsum * sdsum - float(vsum))
        rows.append({'name': ps['name'], 'emv': fl(mean), 'stdDev': math.sqrt(max(0.0, var)), 'independentStdDev': math.sqrt(float(vsum))})
        # the exact chance of a loss for independent holdings: every success/failure combination
        hs = ps['holdings']
        ploss, atoms = 0.0, {}
        if rho == 0 and len(hs) <= 16:
            for mask in range(1 << len(hs)):
                pr_, mu, s2 = F(1), F(0), 0.0
                for j, h in enumerate(hs):
                    p = F(h['chanceOfSuccessPct']) / 100
                    if mask >> j & 1:
                        pr_ *= p
                        mu += F(h['successValue'])
                        s2 += h['successStdDev'] ** 2
                    else:
                        pr_ *= 1 - p
                        mu -= F(h['failCost'])
                if pr_ == 0:
                    continue
                ploss += float(pr_) * ((1.0 if mu < 0 else 0.0) if s2 == 0 else phi(-float(mu) / math.sqrt(s2)))
                if all(h['successStdDev'] == 0 for h in hs):
                    atoms[mu] = atoms.get(mu, F(0)) + pr_
            q = {}
            if atoms:
                cum, items = F(0), sorted(atoms.items())
                for qq, key in [(F(1, 10), 'p90'), (F(9, 10), 'p10')]:
                    cum = F(0)
                    for j, (x, w) in enumerate(items):
                        before = cum
                        cum += w
                        if cum >= qq:
                            q[key] = {'value': fl(x), 'safe': before < qq - F(2, 100) and cum > qq + F(2, 100)}
                            break
            exact.append({'name': ps['name'], 'probLoss': ploss, 'band': 5 * math.sqrt(max(ploss * (1 - ploss), 1e-12) / it), 'quantiles': q})
        else:
            exact.append({'name': ps['name'], 'probLoss': None, 'band': None, 'quantiles': {}})
    return {'correlation': rho, 'seed': seed, 'iterations': it, 'positions': rows, '_exact': exact}


# ------------------------------------------------------------------ consent fee
def consent(a):
    basis, lic, tv, vs, ig, rates, pay = (g(a, k) for k in ['basis', 'licence', 'transactionValue', 'valueSource', 'intraGroup', 'ratesPct', 'payment'])
    one_of('basis', basis, ['nuprc-2024-r19', 'stated'])
    one_of('licence', lic, ['PPL', 'PML', 'PEL'])
    non_neg('transactionValue', tv)
    one_of('valueSource', vs, ['contract-amount', 'commission-determined'])
    if basis == 'nuprc-2024-r19':
        if lic == 'PEL':
            must('licence', '"PPL" or "PML" under basis "nuprc-2024-r19": reg. 19(2) sets the fee for the consent of the Minister, and a PEL assignment needs the consent of the Commission (reg. 16); state its rates under basis "stated"', lic)
        if not isinstance(ig, bool):
            must('intraGroup', 'true or false (stated; no default)', ig)
        if rates is not MISSING:
            must('ratesPct', 'left out under basis "nuprc-2024-r19" (2% processing and 5% premium, reg. 19(2))', rates)
        proc, prem = PROCESSING_PCT, 0 if ig else PREMIUM_PCT
    else:
        if ig is not MISSING:
            must('intraGroup', 'left out under basis "stated" (the stated rates apply)', ig)
        if pay is not MISSING:
            must('payment', 'left out under basis "stated" (the payment timing is reg. 19(7) to (9))', pay)
        if not isobj(rates):
            must('ratesPct', 'an object { processingPct, premiumPct } under basis "stated" (no default)', rates)
        pct('ratesPct.processingPct', g(rates, 'processingPct'))
        pct('ratesPct.premiumPct', g(rates, 'premiumPct'))
        proc, prem = rates['processingPct'], rates['premiumPct']
    if pay is not MISSING:
        if not isobj(pay):
            must('payment', 'an object { notifiedOn, paidOn } when given', pay)
        real_date('payment.notifiedOn', g(pay, 'notifiedOn'))
        real_date('payment.paidOn', g(pay, 'paidOn'))
        if pay['paidOn'] < pay['notifiedOn']:
            must('payment.paidOn', f'on or after the notification {pay["notifiedOn"]}', pay['paidOn'])
    pf, pm = F(tv) * F(proc) / 100, F(tv) * F(prem) / 100
    fee = pf + pm
    src = 'the amount payable to the Assignor stated in the contract' if vs == 'contract-amount' else 'an amount the Commission determines'
    reasons = [f'{lic}: {js(proc)}% processing' + (f' + {js(prem)}% premium' if prem > 0 else '') + f' on the value of the transaction {money(tv)} ({src}, reg. 19(3)) = {money(fee)}'
               + (' (an intra group transfer: the processing fee alone)' if basis == 'nuprc-2024-r19' and ig else '') + '; paid by the Assignor and not tax deductible']
    po = None
    if pay is not MISSING:
        days = (parse_day(pay['paidOn']) - parse_day(pay['notifiedOn'])).days
        if days <= PAY_WITHIN:
            st, sd = 'on-time', 0
        elif days <= PAY_WITHIN + GRACE:
            st, sd = 'within-grace', 0
        elif days <= PAY_WITHIN + GRACE + SURCHARGE_DAYS:
            st, sd = 'surcharge', days - PAY_WITHIN - GRACE
        else:
            st, sd = 'consent-deemed-withdrawn', 0
        sur = fee * SURCHARGE_PCT_DAY * sd / 100
        po = {'days': days, 'status': st, 'surchargeDays': sd, 'surcharge': fl(sur), 'totalPaid': None if st == 'consent-deemed-withdrawn' else fl(fee + sur)}
        if st == 'on-time':
            reasons.append(f'paid {unit(days, "day")} after the notification: within the {PAY_WITHIN} days of reg. 19(7)')
        elif st == 'within-grace':
            reasons.append(f'paid {unit(days, "day")} after the notification: inside the further {GRACE} days of reg. 19(8); no surcharge')
        elif st == 'surcharge':
            reasons.append(f'paid {unit(days, "day")} after the notification: {unit(sd, "day")} after the {PAY_WITHIN} + {GRACE} days; surcharge 0.01% of {money(fee)} x {unit(sd, "day")} = {money(sur)} (reg. 19(9), straight line)')
        else:
            reasons.append(f'paid {unit(days, "day")} after the notification: more than {SURCHARGE_DAYS} surcharge days after the {PAY_WITHIN} + {GRACE} days; the consent is deemed withdrawn (reg. 19(9))')
    return {'licence': lic, 'feeBasis': basis, 'transactionValue': tv, 'valueSource': vs, 'intraGroup': None if ig is MISSING else ig,
            'processingPct': proc, 'premiumPct': prem, 'processingFee': fl(pf), 'premium': fl(pm), 'fee': fl(fee), 'taxDeductible': False, 'payer': 'assignor',
            'payment': po, 'reasons': reasons}


# ---------------------------------------------- after the farm-in (EC9 witness)
def post_deal(a, Fp, keep):
    y = g(a, 'earnedPct')
    pct_pos('earnedPct', y)
    if (not y < Fp) if keep else y > Fp:
        must('earnedPct', f"below the farmor's interest {js(Fp)} (the farmor keeps a carried interest)" if keep else f"at most the farmor's interest {js(Fp)}", y)
    rows = interests_after(a['parties'], a['farmor'], a['farminee']['id'], y)
    return [r for r in rows if r['participatingPct'] > 0]


def dev_carry(a):
    Fp, _ = check_deal_parties(a)
    rows = post_deal(a, Fp, True)
    farmor, fid = a['farmor'], a['farminee']['id']
    args = {'parties': rows, 'carries': [{'carried': farmor, 'carriedPct': g(a, 'carriedPct'), 'carriers': {fid: 100}}], 'carried': farmor, 'basis': 'contract'}
    for k in ['years', 'uplift', 'recoverFromPct', 'cap', 'discountRate', 'baseYear']:
        if g(a, k) is not MISSING:
            args[k] = a[k]
    try:
        r = OJ.carry(args)
    except OJ.Refusal as e:
        if e.field.startswith('carries[0].'):
            raise Refusal(e.field[len('carries[0].'):], e.message[len(e.field) + 1:])
        raise
    head = f'after the farm-in: {", ".join(f"{x["id"]} {dec(x["participatingPct"])}%" for x in rows)}; {fid} carries {js(a["carriedPct"])}% of {farmor}\'s {dec(F(Fp) - F(a["earnedPct"]))}% cost share'
    out = {'interestsAfter': rows}
    out.update(r)
    out['reasons'] = [head] + r['reasons']
    return out


def back_in_right(a):
    Fp, _ = check_deal_parties(a)
    rows = post_deal(a, Fp, False)
    b = g(a, 'backIn')
    if not isobj(b):
        must('backIn', 'an object { party, targetPct, costs, basis, refundForm, ... }', b)
    one_of('backIn.party', g(b, 'party'), [x['id'] for x in rows])
    args = {'parties': rows, 'backInParty': b['party']}
    for k, v in b.items():
        if k != 'party' and v is not None:
            args[k] = v
    try:
        r = OJ.back_in(args)
    except OJ.Refusal as e:
        raise Refusal(f'backIn.{e.field}', e.message[len(e.field) + 1:])
    out = {'interestsAfterFarmIn': rows}
    out.update(r)
    out['reasons'] = [f'after the farm-in: {", ".join(f"{x["id"]} {dec(x["participatingPct"])}%" for x in rows)}'] + r['reasons']
    return out


FNS = {'earningObligation': earning, 'dealValue': deal_value, 'informationValue': info_value, 'interestValue': interest_value,
       'riskSharing': risk, 'consentFee': consent, 'developmentCarry': dev_carry, 'backInRight': back_in_right}


def run(fn, args):
    try:
        if not isobj(args):
            must('options', 'an object of named inputs', args)
        OJ.check_keys(args, SHAPES[fn], '')
        return FNS[fn](args)
    except Refusal as r:
        return {'error': True, 'field': r.field, 'message': r.message}


CASES = []


def case(cid, fn, args, tol=1e-9, **extra):
    args = json.loads(json.dumps(args))
    exp = run(fn, json.loads(json.dumps(args)))
    if isinstance(exp, dict) and '_exact' in exp:
        extra['mc'] = exp.pop('_exact')
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


def ok(cid, fn, args, **extra):
    exp = case(cid, fn, args, **extra)
    if isinstance(exp, dict) and exp.get('error') is True:
        sys.exit(f'{cid}: unexpected refusal: {exp["message"]}')
    return exp


def without(d, *keys):
    return {k: v for k, v in d.items() if k not in keys}


# ------------------------------------------------------------------- cases
def build():
    fx = json.load(open(FIX))
    P, FAR, FE = fx['parties'], fx['farmor'], fx['farminee']
    base = {'parties': P, 'farmor': FAR, 'farminee': FE}
    PRJ, DEAL = fx['project'], fx['deal']
    NONE = {'on': 'none'}
    PAST0 = {'amount': 0, 'reimbursedPct': 0}

    # ---- earning obligation
    ok('earn-ekene-single', 'earningObligation', dict(base, **fx['earning']['singleWell']))
    ok('earn-ekene-drill-to-earn', 'earningObligation', dict(base, **fx['earning']['drillToEarn']))
    ok('earn-ekene-drill-to-earn-done', 'earningObligation', dict(base, **dict(fx['earning']['drillToEarn'], eventsCompleted=2)))
    ok('earn-ekene-drill-to-earn-per-event', 'earningObligation', dict(base, **dict(fx['earning']['drillToEarn'], vesting='per-event')))
    ok('earn-ekene-drill-to-earn-none-done', 'earningObligation', dict(base, **dict(fx['earning']['drillToEarn'], eventsCompleted=0)))
    one = lambda **k: dict(base, events=[dict({'name': 'well', 'grossCost': 40000000, 'farmineePaysPct': 40, 'earnedPct': 30, 'cap': NONE}, **k)],  # noqa: E731
                           vesting='per-event', eventsCompleted=1, cashBonus=0, pastCosts=PAST0)
    ok('earn-third-for-a-quarter', 'earningObligation', dict(base, events=[{'name': 'well', 'grossCost': 12000000, 'farmineePaysPct': 100 / 3 * 1, 'earnedPct': 25, 'cap': NONE}],
                                                             vesting='per-event', eventsCompleted=1, cashBonus=0, pastCosts=PAST0) | {'parties': [{'id': 'EKO', 'participatingPct': 100}]})
    ok('earn-heads-up', 'earningObligation', one(farmineePaysPct=30))
    ok('earn-full-carry', 'earningObligation', one(farmineePaysPct=70))
    ok('earn-cap-gross-below', 'earningObligation', one(cap={'on': 'gross-cost', 'amount': 50000000, 'overrunRule': 'post-deal-interests'}))
    ok('earn-cap-gross-exactly', 'earningObligation', one(cap={'on': 'gross-cost', 'amount': 40000000, 'overrunRule': 'post-deal-interests'}))
    ok('earn-cap-gross-exceeded-post', 'earningObligation', one(grossCost=48000000, cap={'on': 'gross-cost', 'amount': 40000000, 'overrunRule': 'post-deal-interests'}))
    ok('earn-cap-gross-exceeded-farmor-side', 'earningObligation', one(grossCost=48000000, cap={'on': 'gross-cost', 'amount': 40000000, 'overrunRule': 'farmor-side'}))
    ok('earn-cap-carry-below', 'earningObligation', one(cap={'on': 'carry-amount', 'amount': 5000000}))
    ok('earn-cap-carry-exactly', 'earningObligation', one(cap={'on': 'carry-amount', 'amount': 4000000}))
    ok('earn-cap-carry-exceeded', 'earningObligation', one(cap={'on': 'carry-amount', 'amount': 2500000}))
    ok('earn-cap-carry-zero', 'earningObligation', one(cap={'on': 'carry-amount', 'amount': 0}))
    ok('earn-bonus-and-reimbursement', 'earningObligation', dict(one(), cashBonus=1500000, pastCosts={'amount': 9000000, 'reimbursedPct': 30}))
    ok('earn-all-of-farmor', 'earningObligation', one(farmineePaysPct=70, earnedPct=70))
    ok('earn-none-completed', 'earningObligation', dict(one(), eventsCompleted=0))
    refused('earn-refuse-negative-promote', 'earningObligation', one(farmineePaysPct=25), 'events[0].farmineePaysPct')
    refused('earn-refuse-pays-above-farmor', 'earningObligation', one(farmineePaysPct=75), 'events[0].farmineePaysPct')
    refused('earn-refuse-earn-above-farmor', 'earningObligation', one(earnedPct=71, farmineePaysPct=71), 'events[0].earnedPct')
    refused('earn-refuse-cumulative-above-farmor', 'earningObligation', dict(base, events=[
        {'name': 'a', 'grossCost': 1, 'farmineePaysPct': 50, 'earnedPct': 40, 'cap': NONE}, {'name': 'b', 'grossCost': 1, 'farmineePaysPct': 70, 'earnedPct': 35, 'cap': NONE}],
        vesting='per-event', eventsCompleted=2, cashBonus=0, pastCosts=PAST0), 'events[1].earnedPct')
    refused('earn-refuse-no-cap', 'earningObligation', dict(one(), events=[without(one()['events'][0], 'cap')]), 'events[0].cap')
    refused('earn-refuse-cap-on', 'earningObligation', one(cap={'on': 'net-cost'}), 'events[0].cap.on')
    refused('earn-refuse-cap-no-rule', 'earningObligation', one(cap={'on': 'gross-cost', 'amount': 1}), 'events[0].cap.overrunRule')
    refused('earn-refuse-cap-amount-none', 'earningObligation', one(cap={'on': 'none', 'amount': 1}), 'events[0].cap.amount')
    refused('earn-refuse-cap-carry-rule', 'earningObligation', one(cap={'on': 'carry-amount', 'amount': 1, 'overrunRule': 'farmor-side'}), 'events[0].cap.overrunRule')
    refused('earn-refuse-gross-cap-zero', 'earningObligation', one(cap={'on': 'gross-cost', 'amount': 0, 'overrunRule': 'farmor-side'}), 'events[0].cap.amount')
    refused('earn-refuse-farminee-is-party', 'earningObligation', dict(one(), farminee={'id': 'PA'}), 'farminee.id')
    refused('earn-refuse-farmor-unknown', 'earningObligation', dict(one(), farmor='XX'), 'farmor')
    refused('earn-refuse-no-bonus', 'earningObligation', without(one(), 'cashBonus'), 'cashBonus')
    refused('earn-refuse-no-past', 'earningObligation', without(one(), 'pastCosts'), 'pastCosts')
    refused('earn-refuse-vesting', 'earningObligation', dict(one(), vesting='on-signing'), 'vesting')
    refused('earn-refuse-completed-above', 'earningObligation', dict(one(), eventsCompleted=2), 'eventsCompleted')
    refused('earn-refuse-duplicate-event', 'earningObligation', dict(one(), events=one()['events'] + [dict(one()['events'][0], farmineePaysPct=70, earnedPct=10)]), 'events[1].name')
    refused('earn-refuse-zero-cost', 'earningObligation', one(grossCost=0), 'events[0].grossCost')
    refused('earn-refuse-parties-sum', 'earningObligation', dict(one(), parties=[{'id': 'EKO', 'participatingPct': 70}, {'id': 'PA', 'participatingPct': 20}]), 'parties')
    refused('earn-refuse-unknown-key', 'earningObligation', dict(one(), carryCap=5), 'carryCap')
    refused('earn-refuse-unknown-cap-key', 'earningObligation', one(cap={'on': 'none', 'limit': 5}), 'events[0].cap.limit')

    # ---- deal value
    dbase = dict(base, project=PRJ, deal=DEAL)
    ok('deal-ekene', 'dealValue', dbase)
    ok('deal-ekene-npv-stated', 'dealValue', dict(dbase, project=dict(PRJ, successValue={'npv': 271250000})))
    ok('deal-ekene-carry-cap', 'dealValue', dict(dbase, deal=dict(DEAL, cap={'on': 'carry-amount', 'amount': 3000000})))
    ok('deal-ekene-farmor-side', 'dealValue', dict(dbase, deal=dict(DEAL, cap={'on': 'gross-cost', 'amount': 44000000, 'overrunRule': 'farmor-side'})))
    ok('deal-ekene-no-cap', 'dealValue', dict(dbase, deal=dict(DEAL, cap=NONE)))
    ok('deal-ekene-dry-hole', 'dealValue', dict(dbase, project=dict(PRJ, chanceOfSuccessPct=0)))
    ok('deal-ekene-certain', 'dealValue', dict(dbase, project=dict(PRJ, chanceOfSuccessPct=100)))
    ok('deal-ekene-bonus-zero', 'dealValue', dict(dbase, deal=dict(DEAL, cashBonus=0, assignorFees=0)))
    # PSU EME 801 Table 6.1: drill yourself -250,000 / 500,000; farm out 0 / 50,000; P(producer) 0.35.
    # Sole farmor, heads-up well of 250,000 in both outcomes; the retained 1/15 of 750,000 is 50,000.
    ok('deal-psu-eme801', 'dealValue', {'parties': [{'id': 'YOU', 'participatingPct': 100}], 'farmor': 'YOU', 'farminee': {'id': 'DRILLER'},
                                        'project': {'chanceOfSuccessPct': 35, 'wellCost': {'success': 250000, 'dry': 250000}, 'successValue': {'npv': 750000}},
                                        'deal': {'farmineePaysPct': 100, 'earnedPct': 100 - 100 / 15, 'cap': NONE, 'cashBonus': 0, 'pastCosts': PAST0, 'assignorFees': 0}},
       source='Penn State EME 801 Lesson 6, Table 6.1 and the EMV working (CC BY-NC-SA 4.0): EMV(Drill) = 12,500, EMV(Farmout) = 17,500')
    # promote exactly at break-even: sole farmor, Y 40, success value 8,000,000, well 1,600,000, p 25%: X* = 50
    be = {'parties': [{'id': 'F', 'participatingPct': 100}], 'farmor': 'F', 'farminee': {'id': 'N'},
          'project': {'chanceOfSuccessPct': 25, 'wellCost': {'success': 1600000, 'dry': 1600000}, 'successValue': {'npv': 8000000}},
          'deal': {'farmineePaysPct': 50, 'earnedPct': 40, 'cap': NONE, 'cashBonus': 0, 'pastCosts': PAST0, 'assignorFees': 0}}
    ok('deal-promote-exactly-break-even', 'dealValue', be)
    ok('deal-promote-just-above-break-even', 'dealValue', dict(be, deal=dict(be['deal'], farmineePaysPct=50.5)))
    ok('deal-negative-without-promote', 'dealValue', dict(be, project=dict(be['project'], chanceOfSuccessPct=10)))
    ok('deal-positive-at-farmor-share', 'dealValue', dict(be, project=dict(be['project'], chanceOfSuccessPct=90)))
    ok('deal-break-even-at-farmor-share', 'dealValue', dict(be, project=dict(be['project'], chanceOfSuccessPct=50), deal=dict(be['deal'], farmineePaysPct=100)))
    ok('deal-carry-cap-kinks', 'dealValue', dict(be, deal=dict(be['deal'], cap={'on': 'carry-amount', 'amount': 200000})))
    ok('deal-carry-cap-flat-positive', 'dealValue', dict(be, deal=dict(be['deal'], cap={'on': 'carry-amount', 'amount': 20000})))
    refused('deal-refuse-no-fees', 'dealValue', dict(dbase, deal=without(DEAL, 'assignorFees')), 'deal.assignorFees')
    refused('deal-refuse-chance', 'dealValue', dict(dbase, project=dict(PRJ, chanceOfSuccessPct=101)), 'project.chanceOfSuccessPct')
    refused('deal-refuse-no-dry-cost', 'dealValue', dict(dbase, project=dict(PRJ, wellCost={'success': 1})), 'project.wellCost.dry')
    refused('deal-refuse-no-value', 'dealValue', dict(dbase, project=without(PRJ, 'successValue')), 'project.successValue')
    refused('deal-refuse-empty-value', 'dealValue', dict(dbase, project=dict(PRJ, successValue={})), 'project.successValue')
    refused('deal-refuse-npv-and-flows', 'dealValue', dict(dbase, project=dict(PRJ, successValue=dict(PRJ['successValue'], npv=1))), 'project.successValue.cashFlows')
    refused('deal-refuse-no-rate', 'dealValue', dict(dbase, project=dict(PRJ, successValue=without(PRJ['successValue'], 'discountRate'))), 'project.successValue.discountRate')
    refused('deal-refuse-gap-year', 'dealValue', dict(dbase, project=dict(PRJ, successValue=dict(PRJ['successValue'], cashFlows=[{'year': 2029, 'net': 1}, {'year': 2031, 'net': 1}]))),
            'project.successValue.cashFlows[1].year')
    refused('deal-refuse-negative-promote', 'dealValue', dict(dbase, deal=dict(DEAL, farmineePaysPct=20)), 'deal.farmineePaysPct')
    refused('deal-refuse-unknown-deal-key', 'dealValue', dict(dbase, deal=dict(DEAL, promotePct=10)), 'deal.promotePct')
    refused('deal-refuse-unknown-project-key', 'dealValue', dict(dbase, project=dict(PRJ, pos=0.25)), 'project.pos')

    # ---- information value
    ib = dict(dbase, side='farminee', information=fx['information'])
    ok('info-ekene-farminee', 'informationValue', ib)
    ok('info-ekene-farmor', 'informationValue', dict(ib, side='farmor'))
    ok('info-ekene-too-dear', 'informationValue', dict(ib, information=dict(fx['information'], cost=9000000)))
    ok('info-uninformative', 'informationValue', dict(ib, information={'cost': 0, 'signals': [{'label': 'a', 'likelihoodsPct': [50, 50]}, {'label': 'b', 'likelihoodsPct': [50, 50]}]}))
    refused('info-refuse-side', 'informationValue', dict(ib, side='partner'), 'side')
    refused('info-refuse-one-signal', 'informationValue', dict(ib, information={'cost': 0, 'signals': [{'label': 'a', 'likelihoodsPct': [100, 100]}]}), 'information.signals')
    refused('info-refuse-sum', 'informationValue', dict(ib, information={'cost': 0, 'signals': [{'label': 'a', 'likelihoodsPct': [75, 25]}, {'label': 'b', 'likelihoodsPct': [20, 75]}]}), 'information.signals')
    refused('info-refuse-shape', 'informationValue', dict(ib, information={'cost': 0, 'signals': [{'label': 'a', 'likelihoodsPct': [75]}, {'label': 'b', 'likelihoodsPct': [25, 75]}]}), 'information.signals[0].likelihoodsPct')

    # ---- interest value
    ok('interest-ekene-risked', 'interestValue', dict(fx['interestPrice'], project=PRJ))
    ok('interest-ekene-success-case', 'interestValue', dict(fx['interestPrice'], project=PRJ, valueBasis='success-case'))
    ok('interest-psu-10pct', 'interestValue', {'project': {'chanceOfSuccessPct': 35, 'wellCost': {'success': 250000, 'dry': 250000}, 'successValue': {'npv': 750000}}, 'interestPct': 10, 'valueBasis': 'risked'})
    ok('interest-production-metric', 'interestValue', {'project': {'chanceOfSuccessPct': 100, 'wellCost': {'success': 0, 'dry': 0}, 'successValue': {'npv': 80000000}}, 'interestPct': 20,
                                                       'valueBasis': 'success-case', 'transaction': {'price': 18000000, 'production': {'grossRate': 5000, 'rateUnit': 'boe/d'}}})
    ok('interest-negative-emv', 'interestValue', {'project': {'chanceOfSuccessPct': 5, 'wellCost': {'success': 40000000, 'dry': 40000000}, 'successValue': {'npv': 200000000}}, 'interestPct': 25,
                                                  'valueBasis': 'risked', 'transaction': {'price': 1000000}})
    refused('interest-refuse-basis', 'interestValue', {'project': PRJ, 'interestPct': 30, 'valueBasis': 'unrisked'}, 'valueBasis')
    refused('interest-refuse-unit-without-reserves', 'interestValue', {'project': PRJ, 'interestPct': 30, 'valueBasis': 'risked', 'transaction': {'price': 1, 'volumeUnit': 'boe'}}, 'transaction.volumeUnit')
    refused('interest-refuse-no-unit', 'interestValue', {'project': PRJ, 'interestPct': 30, 'valueBasis': 'risked', 'transaction': {'price': 1, 'reserves': [{'category': '2P', 'grossVolume': 1}]}}, 'transaction.volumeUnit')
    refused('interest-refuse-zero-interest', 'interestValue', {'project': PRJ, 'interestPct': 0, 'valueBasis': 'risked'}, 'interestPct')

    # ---- risk sharing: positions from this oracle's own deal payoffs
    dv = deal_value(json.loads(json.dumps(dbase)))
    alone, fo = dv['farmor']['alone'], dv['farmor']['farmOut']
    cash = fo['dry'] + dv['wellCostSplit']['dry']['farmorPays']
    positions = [
        {'name': 'EKO drills Ekene Deep alone (70%)', 'holdings': [{'id': 'Ekene Deep 70%', 'chanceOfSuccessPct': PRJ['chanceOfSuccessPct'], 'successValue': alone['success'], 'failCost': -alone['dry'], 'successStdDev': 0}]},
        {'name': 'EKO after the farm-out (40% and the cash)', 'holdings': [
            {'id': 'Ekene Deep 40%', 'chanceOfSuccessPct': PRJ['chanceOfSuccessPct'], 'successValue': fo['success'] - cash, 'failCost': dv['wellCostSplit']['dry']['farmorPays'], 'successStdDev': 0},
            {'id': 'cash received', 'chanceOfSuccessPct': 100, 'successValue': cash, 'failCost': 0, 'successStdDev': 0}]},
    ]
    ok('risk-ekene', 'riskSharing', dict(fx['risk'], positions=positions))
    ok('risk-psu', 'riskSharing', {'correlation': 0, 'seed': 7, 'iterations': 50000, 'positions': [
        {'name': 'drill yourself', 'holdings': [{'id': 'field', 'chanceOfSuccessPct': 35, 'successValue': 500000, 'failCost': 250000, 'successStdDev': 0}]},
        {'name': 'farm out', 'holdings': [{'id': 'field', 'chanceOfSuccessPct': 35, 'successValue': 50000, 'failCost': 0, 'successStdDev': 0}]}]})
    ok('risk-spread-four', 'riskSharing', {'correlation': 0, 'seed': 11, 'iterations': 50000, 'positions': [
        {'name': 'one prospect at 100%', 'holdings': [{'id': 'A', 'chanceOfSuccessPct': 25, 'successValue': 200000000, 'failCost': 40000000, 'successStdDev': 50000000}]},
        {'name': 'four prospects at 25%', 'holdings': [{'id': k, 'chanceOfSuccessPct': 25, 'successValue': 50000000, 'failCost': 10000000, 'successStdDev': 12500000} for k in 'ABCD']}]})
    ok('risk-correlated', 'riskSharing', {'correlation': 0.5, 'seed': 11, 'iterations': 20000, 'positions': [
        {'name': 'four prospects at 25%, correlated', 'holdings': [{'id': k, 'chanceOfSuccessPct': 25, 'successValue': 50000000, 'failCost': 10000000, 'successStdDev': 0} for k in 'ABCD']}]})
    refused('risk-refuse-no-seed', 'riskSharing', {'correlation': 0, 'iterations': 10, 'positions': positions}, 'seed')
    refused('risk-refuse-iterations', 'riskSharing', {'correlation': 0, 'seed': 1, 'iterations': 200001, 'positions': positions}, 'iterations')
    refused('risk-refuse-work', 'riskSharing', {'correlation': 0, 'seed': 1, 'iterations': 200000, 'positions': positions}, 'iterations')
    refused('risk-refuse-correlation', 'riskSharing', {'correlation': -0.1, 'seed': 1, 'iterations': 10, 'positions': positions}, 'correlation')
    refused('risk-refuse-no-sd', 'riskSharing', {'correlation': 0, 'seed': 1, 'iterations': 10, 'positions': [{'name': 'x', 'holdings': [{'id': 'a', 'chanceOfSuccessPct': 1, 'successValue': 1, 'failCost': 1}]}]},
            'positions[0].holdings[0].successStdDev')
    refused('risk-refuse-negative-fail', 'riskSharing', {'correlation': 0, 'seed': 1, 'iterations': 10, 'positions': [{'name': 'x', 'holdings': [{'id': 'a', 'chanceOfSuccessPct': 1, 'successValue': 1, 'failCost': -1, 'successStdDev': 0}]}]},
            'positions[0].holdings[0].failCost')

    # ---- consent fee (AOI Regulations 2024 reg. 19)
    C = fx['consent']
    ok('fee-ekene', 'consentFee', C)
    ok('fee-intra-group', 'consentFee', dict(C, intraGroup=True))
    ok('fee-day-90', 'consentFee', dict(C, payment={'notifiedOn': '2027-01-01', 'paidOn': '2027-04-01'}))
    ok('fee-day-91', 'consentFee', dict(C, payment={'notifiedOn': '2027-01-01', 'paidOn': '2027-04-02'}))
    ok('fee-day-120', 'consentFee', dict(C, payment={'notifiedOn': '2027-01-01', 'paidOn': '2027-05-01'}))
    ok('fee-day-121', 'consentFee', dict(C, payment={'notifiedOn': '2027-01-01', 'paidOn': '2027-05-02'}))
    ok('fee-day-210', 'consentFee', dict(C, payment={'notifiedOn': '2027-01-01', 'paidOn': '2027-07-30'}))
    ok('fee-day-211', 'consentFee', dict(C, payment={'notifiedOn': '2027-01-01', 'paidOn': '2027-07-31'}))
    ok('fee-no-payment', 'consentFee', without(C, 'payment'))
    ok('fee-pel-stated', 'consentFee', {'licence': 'PEL', 'transactionValue': 1000000, 'valueSource': 'commission-determined', 'basis': 'stated', 'ratesPct': {'processingPct': 1.5, 'premiumPct': 0}})
    refused('fee-refuse-pel-r19', 'consentFee', dict(C, licence='PEL'), 'licence')
    refused('fee-refuse-no-intra', 'consentFee', without(C, 'intraGroup'), 'intraGroup')
    refused('fee-refuse-rates-r19', 'consentFee', dict(C, ratesPct={'processingPct': 1, 'premiumPct': 1}), 'ratesPct')
    refused('fee-refuse-stated-no-rates', 'consentFee', {'licence': 'PEL', 'transactionValue': 1, 'valueSource': 'contract-amount', 'basis': 'stated'}, 'ratesPct')
    refused('fee-refuse-stated-intra', 'consentFee', {'licence': 'PEL', 'transactionValue': 1, 'valueSource': 'contract-amount', 'basis': 'stated', 'intraGroup': False}, 'intraGroup')
    refused('fee-refuse-stated-payment', 'consentFee', {'licence': 'PEL', 'transactionValue': 1, 'valueSource': 'contract-amount', 'basis': 'stated', 'payment': C['payment']}, 'payment')
    refused('fee-refuse-paid-before', 'consentFee', dict(C, payment={'notifiedOn': '2027-01-10', 'paidOn': '2027-01-09'}), 'payment.paidOn')
    refused('fee-refuse-bad-date', 'consentFee', dict(C, payment={'notifiedOn': '2027-02-30', 'paidOn': '2027-03-01'}), 'payment.notifiedOn')
    refused('fee-refuse-value-source', 'consentFee', dict(C, valueSource='market'), 'valueSource')

    # ---- after the farm-in (jointVenture.js through the EC9 witness)
    ok('devcarry-ekene', 'developmentCarry', dict(base, **fx['developmentCarry']))
    ok('devcarry-ekene-none-capped', 'developmentCarry', dict(base, **dict(fx['developmentCarry'], uplift={'type': 'none'}, cap=100000000)))
    ok('devcarry-recovered-exactly', 'developmentCarry', dict(base, earnedPct=30, carriedPct=100,
                                                              years=[{'year': 2030, 'cost': 1000, 'entitlement': 0}, {'year': 2031, 'cost': 0, 'entitlement': 1000}], uplift={'type': 'none'}, recoverFromPct=100))
    refused('devcarry-refuse-earn-all', 'developmentCarry', dict(base, **dict(fx['developmentCarry'], earnedPct=70)), 'earnedPct')
    refused('devcarry-refuse-carried-pct', 'developmentCarry', dict(base, **dict(fx['developmentCarry'], carriedPct=0)), 'carriedPct')
    ok('devcarry-ekene-simple-ot18360', 'developmentCarry', dict(base, **dict(fx['developmentCarry'], uplift={'type': 'simple', 'ratePctPerYear': 8, 'dayBasis': 'annual-period'})))
    refused('devcarry-refuse-no-uplift', 'developmentCarry', dict(base, **without(fx['developmentCarry'], 'uplift')), 'uplift')
    ok('backin-ekene', 'backInRight', dict(base, **fx['backIn']))
    ok('backin-ekene-pia', 'backInRight', dict(base, earnedPct=30, backIn={'party': 'PA', 'targetPct': 60, 'costs': fx['backIn']['backIn']['costs'], 'basis': 'pia-s85-4',
                                                                        'refundForm': 'from-future-entitlement', 'recoverFromPct': 50,
                                                                        'years': [{'year': y, 'entitlement': 400000000} for y in range(2033, 2037)]}))
    refused('backin-refuse-party', 'backInRight', dict(base, earnedPct=30, backIn=dict(fx['backIn']['backIn'], party='NOC')), 'backIn.party')
    refused('backin-refuse-target', 'backInRight', dict(base, earnedPct=30, backIn=dict(fx['backIn']['backIn'], targetPct=35)), 'backIn.targetPct')
    refused('backin-refuse-earned', 'backInRight', dict(base, earnedPct=80, backIn=fx['backIn']['backIn']), 'earnedPct')


def main():
    build()
    ids = [c['id'] for c in CASES]
    if len(set(ids)) != len(ids):
        sys.exit('duplicate case ids')
    doc = {
        'module': 'farmout',
        'generatedBy': 'tools/validation/economics/oracle_farmout.py',
        'engine': 'engines/economics/farmout.js',
        'tolerance': {'absoluteFloor': 1e-6, 'note': 'relative tol per case (1e-9); absolute floor 1e-6 in the money unit; Monte Carlo fields of riskSharing are checked against the exact figures in each case\'s "mc" within a 5-sigma binomial band'},
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
