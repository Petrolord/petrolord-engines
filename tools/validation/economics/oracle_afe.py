#!/usr/bin/env python3
"""Independent oracle for the AFE cost control engine
(engines/economics/afe.js: calculatePartnerCosts, calculateMetrics,
generateSCurveData) and the project controls engine
(engines/economics/projectControls.js: calculateEVM, calculateCPI,
calculateSPI, formatTasksForGantt). Emits
test-data/economics/goldens/afe_cases.json.

INDEPENDENCE DISCIPLINE. Written from the METHOD STATEMENTS the modules
document and from the standard earned-value definitions (PMI Practice
Standard for Earned Value Management), not by transcribing the JavaScript:

  partner split   every partner takes working_interest percent of the
                  cost; the operator takes the remainder of 100 percent.
                  The oracle ALSO asserts the accounting identity the
                  Suite test names (every currency unit allocated exactly
                  once: partner shares plus operator amount equals the
                  cost) and the validity rule (interests over 100 refused
                  with the note; a shortfall accepted), and it renders the
                  note's two-decimal figure with the ECMAScript toFixed
                  rule (round half away from zero on the exact binary
                  value) written out on Decimal, not with Python's
                  banker's rounding.

  earned value    the module defines BAC as the budget sum, AC as the
                  actual sum, EV as the budget-weighted progress, EAC per
                  item as the entered forecast when positive else
                  max(budget, actual + commitment), variance as BAC less
                  EAC, CPI as EV / AC (1 when nothing is spent), and SPI as
                  EV / (BAC x time progress), the documented
                  simplification that planned value is the budget spread
                  linearly over the AFE window. The oracle writes the
                  standard formulas: PV = BAC x elapsed fraction, CV = EV
                  minus AC, SV = EV minus PV, CPI, SPI, EAC, ETC = EAC
                  minus AC, VAC = BAC minus EAC and TCPI = (BAC minus EV)
                  / (BAC minus AC), then maps the module's fields onto
                  them. CV, SV, ETC and TCPI are not reported by the
                  module; they are carried in the golden as reference
                  values so a future reporter has a number to check.

  time progress   the module reads the clock. Every golden AFE window is
                  WHOLLY IN THE PAST (progress 1.0) or WHOLLY IN THE FUTURE
                  (progress 0, where the module divides by zero and reports
                  Infinity or NaN for SPI, recorded as a disagreement with
                  the standard definition, where PV = 0 makes SPI
                  undefined and should be reported as such), or has no or
                  invalid dates (progress 1.0). The goldens are valid until
                  the year 2080, and the description says so.

  S-curve         the module buckets the window by calendar month from the
                  start date (JS setMonth: the day of month is kept and
                  overflows forward), spreads the budget linearly by
                  elapsed full days over the window's full days, cuts
                  actuals from the invoices dated on or before each bucket,
                  and rounds each point with Math.round. The oracle walks
                  the same calendar with date arithmetic (month overflow
                  by the 1st-of-month plus day-offset rule), counts days by
                  subtraction, and rounds with floor(x + 0.5). For a past
                  window the module keeps emitting monthly points up to the
                  current month, so the golden pins the points INSIDE the
                  window and the invariant every later point must satisfy
                  (planned at the full budget, actual and forecast at the
                  invoice total), not a point count that moves with the
                  calendar.

  calculateEVM    PV as the sum of planned cost, EV as planned cost times
                  percent complete, AC as the actual sum; CPI and SPI with
                  the module's zero rules (1 when the divisor is zero and
                  the numerator positive, else 0); every figure rendered
                  with toFixed(2) as the module does, including the "NaN"
                  and "Infinity" strings a zero planned value produces.

Timezone assumption: UTC (date-only strings parse to UTC midnight in both
`new Date` and parseISO, so local and UTC coincide; the dates gate asserts
the zone).

Units: money is whatever the caller's currency is (the AFE app passes its
own); percentages 0 to 100; days are whole days.

stdlib only. Regenerate:
    python3 tools/validation/economics/oracle_afe.py
"""
import json
import math
import os
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'afe_cases.json')

NAN = float('nan')
INF = float('inf')
PAST_LIMIT = date(2025, 12, 31)    # a "past" window ends on or before this
FUTURE_LIMIT = date(2080, 1, 1)    # a "future" window starts on or after this

# ---------------------------------------------------------------------
# JS semantics.
# ---------------------------------------------------------------------


def js_number(v):
    """Number(): None is 0, blank string is 0, booleans 0/1, non numeric NaN."""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        if v.strip() == '':
            return 0.0
        try:
            return float(v.strip())
        except ValueError:
            return NAN
    return NAN


def js_parse_float(v):
    if isinstance(v, bool) or v is None:
        return NAN
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        for n in range(len(s), 0, -1):
            head = s[:n]
            if head[-1] in 'eE+-.' and n > 1 and not head[:-1][-1:].isdigit() and n != 1:
                pass
            try:
                if head.lower().endswith(('e', 'e+', 'e-', '+', '-')):
                    continue
                if 'x' in head.lower() or '_' in head or 'inf' in head.lower() or 'nan' in head.lower():
                    continue
                return float(head)
            except ValueError:
                continue
        return NAN
    return NAN


def truthy(x):
    if x is None or x is False:
        return False
    if isinstance(x, (int, float)):
        return not (x == 0 or x != x)
    if isinstance(x, str):
        return x != ''
    return True


def num_or0(v):
    x = js_number(v)
    return x if truthy(x) else 0.0


def pf_or0(v):
    x = js_parse_float(v)
    return x if truthy(x) else 0.0


def js_round(x):
    if x != x or math.isinf(x):
        return x
    return float(math.floor(x + 0.5))


def js_to_fixed_2(x):
    """Number.prototype.toFixed(2): NaN and infinities by name; otherwise
    the sign, then the closest two-decimal value to |x| with a tie going
    to the larger magnitude, on the EXACT binary value of x."""
    if x != x:
        return 'NaN'
    if math.isinf(x):
        return 'Infinity' if x > 0 else '-Infinity'
    if x == 0:
        return '0.00'
    sign = '-' if x < 0 else ''
    q = Decimal(abs(x)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    return sign + format(q, 'f')


def clean(x):
    if isinstance(x, float) and (x != x or math.isinf(x)):
        return None
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, list):
        return [clean(v) for v in x]
    return x


# ---------------------------------------------------------------------
# Partner split.
# ---------------------------------------------------------------------


def partner_split(total_cost, partners):
    partners = partners or []
    allocations = []
    for p in partners:
        wi = num_or0(p.get('working_interest'))
        allocations.append({**p, 'shareAmount': total_cost * wi / 100.0, 'billingStatus': 'Pending'})
    partner_total = 0.0
    for p in partners:
        partner_total += num_or0(p.get('working_interest'))
    operator_share = 100.0 - partner_total
    operator_amount = total_cost * (operator_share / 100.0)
    note = None
    if operator_share < 0:
        note = ('Partner working interests total %s percent, which is more than the whole. The operator share below is '
                'negative; correct the interests before billing.' % js_to_fixed_2(partner_total))
    allocated = sum(a['shareAmount'] for a in allocations) + operator_amount
    return {'partnerAllocations': allocations, 'operatorShare': operator_share, 'operatorAmount': operator_amount,
            'partnerTotal': partner_total, 'valid': operator_share >= 0, 'note': note,
            'conservation': {'allocated': allocated, 'cost': float(total_cost), 'gap': allocated - total_cost}}


# ---------------------------------------------------------------------
# Time progress and the metrics.
# ---------------------------------------------------------------------


def iso_date(s):
    """parseISO validity for the date-only strings these cases carry."""
    if not isinstance(s, str):
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def window_kind(afe):
    start, end = iso_date((afe or {}).get('start_date')), iso_date((afe or {}).get('end_date'))
    if start is None or end is None:
        return 'none', None, None
    if end <= PAST_LIMIT and start <= PAST_LIMIT:
        return 'past', start, end
    if start >= FUTURE_LIMIT and end >= FUTURE_LIMIT:
        return 'future', start, end
    raise ValueError('golden AFE windows must be wholly past or wholly future: %r' % afe)


def time_progress(afe):
    kind, start, end = window_kind(afe)
    if kind == 'none':
        return 1.0
    if kind == 'future':
        return 0.0
    return 1.0


def metrics(afe, items, invoices=None):
    bac = sum(num_or0(i.get('budget')) for i in items)
    commitments = sum(num_or0(i.get('commitment')) for i in items)
    ac = sum(num_or0(i.get('actual')) for i in items)
    eac = 0.0
    for i in items:
        b, a, c, f = num_or0(i.get('budget')), num_or0(i.get('actual')), num_or0(i.get('commitment')), num_or0(i.get('forecast'))
        eac += f if f > 0 else max(b, a + c)
    vac = bac - eac
    ev = 0.0
    if bac > 0:
        ev = sum(num_or0(i.get('budget')) * (num_or0(i.get('progress')) / 100.0) for i in items)
    tp = time_progress(afe)
    pv = bac * tp
    cpi = ev / ac if ac > 0 else 1.0
    if bac > 0:
        spi = ev / pv if pv != 0 else (INF if ev > 0 else (-INF if ev < 0 else NAN))
    else:
        spi = 1.0
    out = {'totalBudget': bac, 'totalCommitments': commitments, 'totalActuals': ac, 'totalForecast': eac,
           'variance': vac, 'earnedValue': ev, 'cpi': cpi, 'spi': spi,
           'percentSpent': ac / bac * 100.0 if bac > 0 else 0.0,
           'percentComplete': ev / bac * 100.0 if bac > 0 else 0.0,
           'timeProgress': tp,
           'standardEvm': {'bac': bac, 'pv': pv, 'ev': ev, 'ac': ac, 'cv': ev - ac, 'sv': ev - pv,
                           'cpi': ev / ac if ac != 0 else None, 'spi': ev / pv if pv != 0 else None,
                           'eac': eac, 'etc': eac - ac, 'vac': vac,
                           'tcpi': (bac - ev) / (bac - ac) if bac != ac else None}}
    return out


# ---------------------------------------------------------------------
# S-curve.
# ---------------------------------------------------------------------

MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def add_month_js(d):
    """currentDate.setMonth(getMonth() + 1): keep the day, overflow forward."""
    total = d.month  # zero-based month + 1
    y = d.year + total // 12
    m = total % 12 + 1
    return date(y, m, 1) + timedelta(days=d.day - 1)


def display(d):
    return '%s %02d' % (MONTHS[d.month - 1], d.year % 100)


def scurve(afe, items, invoices):
    kind, start, end = window_kind(afe)
    if kind == 'none':
        return {'kind': kind, 'pointsWithinWindow': [], 'afterWindow': None, 'totalBudget': None,
                'totalForecast': None, 'totalDays': None}
    bac = sum(num_or0(i.get('budget')) for i in items)
    # NOTE the different forecast rule from calculateMetrics: here a
    # non-zero entered forecast is used AS IS, negative included.
    eac = 0.0
    for i in items:
        f = js_number(i.get('forecast'))
        eac += f if truthy(f) else max(num_or0(i.get('budget')), num_or0(i.get('actual')) + num_or0(i.get('commitment')))
    total_days = (end - start).days
    daily_budget = bac / max(total_days, 1)
    daily_forecast = eac / max(total_days, 1)
    # `new Date(inv.invoice_date) <= currentDate`: a missing or unparsable
    # date is Invalid Date and never counts; a NULL date is the epoch
    # (new Date(null) is 1970-01-01) and counts in EVERY bucket. See
    # FINDINGS-fdp.md.
    dated = []
    for inv in invoices:
        if 'invoice_date' in inv and inv['invoice_date'] is None:
            dated.append((date(1970, 1, 1), js_number(inv.get('amount'))))
            continue
        d = iso_date(inv.get('invoice_date'))
        if d is not None:
            dated.append((d, js_number(inv.get('amount'))))
    points = []
    cur = start
    while cur <= end:
        elapsed = (cur - start).days
        planned = min(bac, elapsed * daily_budget)
        if kind == 'past':
            actual = sum(a for d, a in dated if d <= cur)
            forecast = actual
            points.append({'date': display(cur), 'Planned': js_round(planned), 'Actual': js_round(actual), 'Forecast': js_round(forecast)})
        else:
            forecast = min(eac, elapsed * daily_forecast)
            points.append({'date': display(cur), 'Planned': js_round(planned), 'Actual': None, 'Forecast': js_round(forecast)})
        cur = add_month_js(cur)
    after = None
    if kind == 'past':
        # Every bucket after the window (the module keeps walking to the
        # current month): the plan is complete, actual is every invoice
        # dated inside or before the walk, forecast follows actual. Only
        # pinned when every invoice falls on or before the window's end,
        # otherwise the later points depend on the calendar.
        if all(d <= end for d, _ in dated) and total_days >= 1:
            total_actual = sum(a for _, a in dated)
            after = {'Planned': js_round(bac), 'Actual': js_round(total_actual), 'Forecast': js_round(total_actual)}
    return {'kind': kind, 'pointsWithinWindow': points, 'afterWindow': after, 'totalBudget': bac,
            'totalForecast': eac, 'totalDays': float(total_days)}


# ---------------------------------------------------------------------
# Project controls.
# ---------------------------------------------------------------------


def evm(tasks):
    pv = ev = ac = 0.0
    for t in tasks:
        pc = pf_or0(t.get('planned_cost'))
        pct = pf_or0(t.get('percent_complete'))
        pv += pc
        ev += pc * (pct / 100.0)
        ac += pf_or0(t.get('actual_cost'))
    cpi = (1.0 if ev > 0 else 0.0) if ac == 0 else ev / ac
    spi = (1.0 if ev > 0 else 0.0) if pv == 0 else ev / pv
    if pv == 0:
        raw = NAN if ev == 0 else (INF if ev > 0 else -INF)
    else:
        raw = ev / pv * 100.0
    numeric = {'pv': pv, 'ev': ev, 'ac': ac, 'cpi': cpi, 'spi': spi, 'cv': ev - ac, 'sv': ev - pv, 'percentCompleteRaw': raw}
    strings = {'plannedValue': js_to_fixed_2(pv), 'earnedValue': js_to_fixed_2(ev), 'actualCost': js_to_fixed_2(ac),
               'cpi': js_to_fixed_2(cpi), 'spi': js_to_fixed_2(spi), 'cv': js_to_fixed_2(ev - ac),
               'sv': js_to_fixed_2(ev - pv), 'percentCompleteRaw': js_to_fixed_2(raw)}
    return {'strings': strings, 'numeric': numeric}


def cpi_spi(ev, divisor):
    if divisor == 0:
        return 1.0 if ev > 0 else 0.0
    return ev / divisor


def js_date_ms(s):
    """new Date(x).getTime() for the values these tasks carry: a date-only
    string is UTC midnight, null is the epoch, undefined or junk is NaN."""
    if s == '__undefined__':
        return NAN
    if s is None:
        return 0.0
    d = iso_date(s)
    if d is None:
        return NAN
    return (d - date(1970, 1, 1)).days * 86400000.0


def gantt(tasks, project):
    out = []
    for t in tasks:
        row = {'id': t.get('id'), 'name': t.get('name'),
               'startMs': js_date_ms(t.get('planned_start_date', '__undefined__')),
               'endMs': js_date_ms(t.get('planned_end_date', '__undefined__')),
               'progress': t.get('percent_complete') if truthy(t.get('percent_complete')) else 0,
               'type': 'milestone' if t.get('type') == 'milestone' else 'task',
               'project': project.get('name'), 'isDisabled': False,
               'styles': {'progressColor': '#84cc16', 'progressSelectedColor': '#65a30d'},
               'owner': t.get('owner'), 'status': t.get('status')}
        preds = t.get('predecessors')
        if isinstance(preds, list) and len(preds) > 0:
            row['dependencies'] = preds
        out.append(row)
    return out


# ---------------------------------------------------------------------
# Cases.
# ---------------------------------------------------------------------

AFE_PAST = {'start_date': '2020-01-01', 'end_date': '2020-12-31', 'currency': 'USD'}
AFE_FUTURE = {'start_date': '2090-01-01', 'end_date': '2090-12-31', 'currency': 'USD'}
PARTNERS = [{'name': 'A', 'working_interest': 30}, {'name': 'B', 'working_interest': 15}]


def partner_cases():
    sets = [
        ('suite test: 1000 across 30 and 15', 1000, PARTNERS),
        ('suite test: conservation on 1234.56', 1234.56, PARTNERS),
        ('suite test: 70 and 45 is more than the whole', 1000, [{'name': 'A', 'working_interest': 70}, {'name': 'B', 'working_interest': 45}]),
        ('suite test: a 10 percent shortfall is valid', 1000, [{'name': 'A', 'working_interest': 10}]),
        ('suite test: no partners', 500, []),
        ('suite test: blank interest is zero', 1000, [{'name': 'A', 'working_interest': ''}]),
        ('exactly 100 percent leaves the operator nothing', 2500, [{'name': 'A', 'working_interest': 60}, {'name': 'B', 'working_interest': 40}]),
        ('100.005 percent: the note rounds half away from zero', 1000, [{'name': 'A', 'working_interest': 50}, {'name': 'B', 'working_interest': 50.005}]),
        ('interest as strings', 800, [{'name': 'A', 'working_interest': '12.5'}, {'name': 'B', 'working_interest': '37.5'}]),
        ('non numeric interest is zero', 800, [{'name': 'A', 'working_interest': 'abc'}, {'name': 'B', 'working_interest': None}]),
        ('zero cost', 0, PARTNERS),
        ('negative cost (a credit) splits the same way', -1000, PARTNERS),
        ('fractional interests in thirds', 1000, [{'name': 'A', 'working_interest': 100 / 3}, {'name': 'B', 'working_interest': 100 / 3}, {'name': 'C', 'working_interest': 100 / 3}]),
        ('fifteen small partners', 12345.67, [{'name': 'P%d' % k, 'working_interest': 5.5} for k in range(15)]),
        ('one partner at 100', 1000, [{'name': 'A', 'working_interest': 100}]),
        ('one partner over 100 alone', 1000, [{'name': 'A', 'working_interest': 120.125}]),
        ('tie at the third decimal: 33.125', 1000, [{'name': 'A', 'working_interest': 33.125}, {'name': 'B', 'working_interest': 67}]),
    ]
    return [{'name': n, 'inputs': {'totalCost': c, 'partners': p}, 'expected': partner_split(c, p)} for n, c, p in sets]


def metrics_cases():
    sets = [
        ('suite test: sums', AFE_PAST, [{'budget': 100, 'commitment': 20, 'actual': 30, 'progress': 0}, {'budget': 200, 'commitment': 50, 'actual': 40, 'progress': 0}], None),
        ('suite test: entered forecast', AFE_PAST, [{'budget': 100, 'commitment': 0, 'actual': 0, 'forecast': 140, 'progress': 0}], None),
        ('suite test: under budget forecasts the budget', AFE_PAST, [{'budget': 100, 'commitment': 10, 'actual': 20, 'progress': 0}], None),
        ('suite test: committed past the budget', AFE_PAST, [{'budget': 100, 'commitment': 60, 'actual': 70, 'progress': 0}], None),
        ('suite test: weighted earned value', AFE_PAST, [{'budget': 100, 'actual': 0, 'progress': 50}, {'budget': 300, 'actual': 0, 'progress': 20}], None),
        ('suite test: CPI 1.25', AFE_PAST, [{'budget': 200, 'actual': 80, 'progress': 50}], None),
        ('suite test: SPI 0.5 at the end of the window', AFE_PAST, [{'budget': 200, 'actual': 100, 'progress': 50}], None),
        ('suite test: empty AFE', AFE_PAST, [], None),
        ('suite test: missing numbers', AFE_PAST, [{'budget': None, 'commitment': '__undefined__', 'actual': '', 'progress': 'x'}], None),
        ('no dates: time progress 1', {'currency': 'USD'}, [{'budget': 400, 'actual': 100, 'progress': 25}], None),
        ('invalid dates: time progress 1', {'start_date': 'not a date', 'end_date': '2020-13-01'}, [{'budget': 400, 'actual': 100, 'progress': 25}], None),
        ('half a date: time progress 1', {'start_date': '2020-01-01'}, [{'budget': 400, 'actual': 100, 'progress': 25}], None),
        ('future window with progress: SPI divides by zero', AFE_FUTURE, [{'budget': 400, 'actual': 100, 'progress': 25}],
         'DISAGREEMENT: time progress is 0 so planned value is 0; the engine reports SPI = Infinity, the standard definition leaves SPI undefined (recorded null).'),
        ('future window with no progress: SPI is NaN', AFE_FUTURE, [{'budget': 400, 'actual': 100, 'progress': 0}],
         'DISAGREEMENT: 0 / 0; the engine reports NaN (recorded null).'),
        ('future window, zero budget: the guard gives 1', AFE_FUTURE, [{'budget': 0, 'actual': 100, 'progress': 0}], None),
        ('negative entered forecast is ignored here (used as is by the S-curve)', AFE_PAST, [{'budget': 100, 'actual': 20, 'commitment': 0, 'forecast': -50, 'progress': 10}],
         'calculateMetrics takes max(budget, actual + commitment) when the entered forecast is not positive; generateSCurveData takes the entered -50. See FINDINGS-fdp.md.'),
        ('strings everywhere', AFE_PAST, [{'budget': '1000', 'commitment': '250', 'actual': '300', 'forecast': '1100', 'progress': '40'}], None),
        ('overspent and overcommitted', AFE_PAST, [{'budget': 100, 'commitment': 80, 'actual': 150, 'progress': 100}, {'budget': 50, 'commitment': 0, 'actual': 0, 'progress': 0}], None),
        ('progress beyond 100 percent earns beyond the budget', AFE_PAST, [{'budget': 100, 'actual': 90, 'progress': 150}], None),
        ('a dozen items', AFE_PAST, [{'budget': 100 * (k + 1), 'commitment': 10 * k, 'actual': 30 * k, 'progress': 8 * k, 'forecast': 0} for k in range(12)], None),
        ('zero budget with actuals: percent spent 0 by the guard', AFE_PAST, [{'budget': 0, 'actual': 500, 'progress': 50}], None),
    ]
    out = []
    for n, afe, items, note in sets:
        items_js = [{k: v for k, v in i.items() if v != '__undefined__'} for i in items]
        c = {'name': n, 'inputs': {'afe': afe, 'costItems': items_js, 'invoices': []}, 'expected': metrics(afe, items_js)}
        if note:
            c['note'] = note
        out.append(c)
    return out


def scurve_cases():
    inv = [{'invoice_date': '2020-02-15', 'amount': 100}, {'invoice_date': '2020-06-15', 'amount': 250}]
    sets = [
        ('suite test: no dates', {}, [{'budget': 100}], []),
        ('suite test: 1200 over 2020, no invoices', AFE_PAST, [{'budget': 1200}], []),
        ('suite test: 1200 over 2020 with two invoices', AFE_PAST, [{'budget': 1200}], inv),
        ('past window, invoices on bucket boundaries', AFE_PAST, [{'budget': 3650}], [{'invoice_date': '2020-01-01', 'amount': 10}, {'invoice_date': '2020-03-01', 'amount': 20}, {'invoice_date': '2020-12-31', 'amount': 30}]),
        ('past window, invoice dated after the window: later points not pinned', AFE_PAST, [{'budget': 1200}], [{'invoice_date': '2020-06-15', 'amount': 250}, {'invoice_date': '2021-03-01', 'amount': 100}]),
        ('past window, string amounts', AFE_PAST, [{'budget': '600', 'actual': '50'}], [{'invoice_date': '2020-04-10', 'amount': '250'}, {'invoice_date': '2020-04-11', 'amount': ''}]),
        ('past window, month-end start overflows the buckets', {'start_date': '2020-01-31', 'end_date': '2020-12-31'}, [{'budget': 1000}], inv),
        ('past window, zero budget', AFE_PAST, [{'budget': 0}], inv),
        ('past window, all invoices unpaid: none dated', AFE_PAST, [{'budget': 1200}], [{'amount': 100}, {'invoice_date': None, 'amount': 200}]),
        ('past window of one day', {'start_date': '2020-06-15', 'end_date': '2020-06-15'}, [{'budget': 500}], [{'invoice_date': '2020-06-15', 'amount': 500}]),
        ('future window: planned and forecast projected, actual null', AFE_FUTURE, [{'budget': 1200, 'commitment': 100, 'actual': 200}], []),
        ('future window with an entered forecast', AFE_FUTURE, [{'budget': 1200, 'forecast': 1500}], []),
        ('future window with a NEGATIVE entered forecast', AFE_FUTURE, [{'budget': 1200, 'forecast': -50}], []),
        ('future window, end before start: no points', {'start_date': '2090-12-31', 'end_date': '2090-01-01'}, [{'budget': 1200}], []),
        ('future window of one day', {'start_date': '2090-06-15', 'end_date': '2090-06-15'}, [{'budget': 500}], []),
        ('future window, Jan 31 start', {'start_date': '2091-01-31', 'end_date': '2091-12-31'}, [{'budget': 1000}], []),
        ('future two-year window', {'start_date': '2090-03-01', 'end_date': '2092-02-29'}, [{'budget': 730, 'forecast': 800}], []),
    ]
    out = []
    for n, afe, items, invs in sets:
        c = {'name': n, 'inputs': {'afe': afe, 'costItems': items, 'invoices': invs}, 'expected': scurve(afe, items, invs)}
        out.append(c)
    return out


def evm_cases():
    sets = [
        ('three tasks', [{'planned_cost': 1000, 'percent_complete': 50, 'actual_cost': 600}, {'planned_cost': 2000, 'percent_complete': 25, 'actual_cost': 400}, {'planned_cost': 500, 'percent_complete': 100, 'actual_cost': 450}], None),
        ('empty task list: NaN percent', [], 'percentCompleteRaw is the string "NaN": 0 / 0.'),
        ('no actuals but progress: CPI 1 by rule', [{'planned_cost': 100, 'percent_complete': 40, 'actual_cost': 0}], None),
        ('no actuals and no progress: CPI 0 by rule', [{'planned_cost': 100, 'percent_complete': 0, 'actual_cost': 0}], None),
        ('tasks without costs: SPI 0 by rule', [{'name': 'x'}, {'name': 'y', 'actual_cost': 20}], None),
        ('strings and blanks', [{'planned_cost': '1500.5', 'percent_complete': '33.3', 'actual_cost': '499.99'}, {'planned_cost': '', 'percent_complete': None, 'actual_cost': 'abc'}], None),
        ('a tie at the third decimal: 0.125 rounds to 0.13', [{'planned_cost': 0.125, 'percent_complete': 100, 'actual_cost': 0.125}], None),
        ('negative cost variance rounds away from zero', [{'planned_cost': 10, 'percent_complete': 100, 'actual_cost': 10.125}], None),
        ('planned value nets to zero with earned value: Infinity percent', [{'planned_cost': -100, 'percent_complete': 50, 'actual_cost': 0}, {'planned_cost': 100, 'percent_complete': 100, 'actual_cost': 0}], 'percentCompleteRaw is the string "Infinity".'),
        ('over budget and behind', [{'planned_cost': 4000, 'percent_complete': 30, 'actual_cost': 2500}], None),
        ('twenty tasks', [{'planned_cost': 100 + 37 * k, 'percent_complete': (k * 13) % 101, 'actual_cost': 90 + 41 * k} for k in range(20)], None),
        ('2.675 does not tie in binary', [{'planned_cost': 2.675, 'percent_complete': 100, 'actual_cost': 2.675}], None),
    ]
    out = []
    for n, tasks, note in sets:
        c = {'name': n, 'inputs': {'tasks': tasks, 'baselineBudget': 10000}, 'expected': evm(tasks)}
        if note:
            c['note'] = note
        out.append(c)
    return out


def cpi_spi_cases():
    pairs = [(100, 80), (100, 100), (50, 200), (0, 0), (10, 0), (-5, 0), (0, 50), (123.456, 78.9), (1e6, 1e-3)]
    return [{'inputs': [ev, d], 'expectedCpi': cpi_spi(ev, d), 'expectedSpi': cpi_spi(ev, d)} for ev, d in pairs]


def gantt_cases():
    project = {'name': 'Example development', 'id': 'p1'}
    tasks = [
        {'id': 't1', 'name': 'Engineering', 'planned_start_date': '2026-01-01', 'planned_end_date': '2026-03-01', 'percent_complete': 45, 'type': 'task', 'owner': 'A', 'status': 'active', 'predecessors': []},
        {'id': 't2', 'name': 'Sanction', 'planned_start_date': '2026-03-01', 'planned_end_date': '2026-03-01', 'percent_complete': 0, 'type': 'milestone', 'owner': 'B', 'status': 'planned', 'predecessors': ['t1']},
        {'id': 't3', 'name': 'Drilling', 'planned_start_date': '2026-03-02', 'planned_end_date': '2026-09-30', 'percent_complete': '30', 'type': 'summary', 'owner': None, 'status': 'planned', 'predecessors': ['t1', 't2']},
        {'id': 't4', 'name': 'No dates', 'percent_complete': None, 'owner': 'C', 'status': 'planned'},
        {'id': 't5', 'name': 'Null dates', 'planned_start_date': None, 'planned_end_date': 'yesterday', 'percent_complete': 100},
    ]
    return [{'name': 'five tasks', 'inputs': {'tasks': tasks, 'project': project}, 'expected': gantt(tasks, project)},
            {'name': 'no tasks', 'inputs': {'tasks': [], 'project': project}, 'expected': []}]


def main():
    golden = {
        'description': (
            'AFE cost control and project controls goldens. partnerSplit: calculatePartnerCosts (shares by working '
            'interest, operator remainder, validity, the note text, and the conservation identity). metrics: '
            'calculateMetrics (BAC, commitments, AC, EAC, VAC, EV, CPI, SPI, percent spent and complete) with the '
            'standard EVM set beside it (pv, cv, sv, etc, tcpi are reference only, not engine outputs). sCurve: '
            'generateSCurveData points inside the window and the after-window invariant for past windows. evm: '
            'projectControls.calculateEVM strings (toFixed(2)) and their numeric values; cpiSpi; gantt: '
            'formatTasksForGantt rows with dates as epoch milliseconds (null = Invalid Date). Independent stdlib '
            'oracle tools/validation/economics/oracle_afe.py. AFE windows are wholly past (2020) or wholly future '
            '(2090 or later): the engine reads the clock and these goldens are valid until 2080. Money in the '
            'caller\'s currency; percentages 0 to 100; days whole. A null where a number is expected is Infinity or '
            'NaN in the engine and the case note says which. Timezone assumption UTC.'),
        'validUntil': FUTURE_LIMIT.isoformat(),
        'partnerSplit': partner_cases(),
        'metrics': metrics_cases(),
        'sCurve': scurve_cases(),
        'evm': evm_cases(),
        'cpiSpi': cpi_spi_cases(),
        'gantt': gantt_cases(),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(clean(golden), fh, indent=1)
        fh.write('\n')
    print('wrote', OUT, {k: len(v) for k, v in golden.items() if isinstance(v, list)})


if __name__ == '__main__':
    main()
