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
                  with the note; a shortfall accepted; since EC5-0 any
                  negative working interest refused too, the note naming
                  each such partner and its value ahead of the over-100
                  sentence, the allocation still returned), and it renders the
                  note's two-decimal figure with the ECMAScript toFixed
                  rule (round half away from zero on the exact binary
                  value) written out on Decimal, not with Python's
                  banker's rounding.

  earned value    the module defines BAC as the budget sum, AC as the
                  actual sum, EV as the budget-weighted progress, EAC per
                  item as the entered forecast when positive else
                  max(budget, actual + commitment) (ONE rule, shared with
                  the S-curve since EC5-0), variance as BAC less EAC, CPI
                  as EV / AC, planned value as BAC x time progress (the
                  documented simplification that the budget is spread
                  linearly over the AFE window) and SPI as EV / PV. A
                  ratio whose denominator is not positive is UNDEFINED and
                  reported as null with a status naming why (EC5-3 and the
                  CPI item, owner decisions 2026-09-15): CPI null with
                  cpiStatus 'no-spend' when AC is not positive; SPI null
                  with spiStatus 'no-budget' when BAC is not positive (the
                  empty AFE included; that test comes first) and
                  'no-planned-value' when BAC is positive but PV is not; a
                  reported ratio has status 'ok'. Progress on any item
                  outside 0 to 100 percent (a number below 0 or above 100;
                  a non-numeric progress is still 0) is refused with an
                  AfeInputError naming the FIRST such item (code, else
                  description, else index) and the value, with a sentence
                  for each side (EC5-8 added the side above 100), as is an
                  invalid asOf, which is checked first. The oracle writes the
                  standard formulas: PV = BAC x elapsed fraction, CV = EV
                  minus AC, SV = EV minus PV, CPI, SPI, EAC, ETC = EAC
                  minus AC, VAC = BAC minus EAC and TCPI = (BAC minus EV)
                  / (BAC minus AC), then maps the module's fields onto
                  them. CV, SV, ETC and TCPI are not reported by the
                  module; they are carried in the golden as reference
                  values so a future reporter has a number to check.

  time progress   measured AS OF a date the caller passes (asOf, a Date or
                  an ISO date string). With no or invalid AFE dates it is
                  1.0. Otherwise it is 0 when asOf is before the start, 1
                  when asOf is after the end, else the whole days elapsed
                  since the start over the whole days in the window (1.0
                  for a zero-day window), whole days meaning the full-day
                  difference truncated toward zero in UTC (lib/dates/dates.js
                  differenceInDays semantics). The module defaults asOf to
                  the clock, so cases WITHOUT an asOf keep the old
                  discipline: every such window is WHOLLY IN THE PAST
                  (progress 1.0) or WHOLLY IN THE FUTURE (progress 0), valid
                  until the year 2080, and the description says so.

  S-curve         the module buckets the window by UTC calendar month from
                  the start date (the day of month is kept and overflows
                  forward), labels each bucket with the English short month
                  and two-digit year of its UTC date, spreads the budget
                  linearly by elapsed full UTC days over the window's full
                  UTC days, cuts
                  actuals from the invoices dated on or before each bucket,
                  and rounds each point with Math.round. Buckets stop at
                  the window's end. A bucket dated on or before asOf shows
                  the invoice total to date as both Actual and Forecast; a
                  later bucket shows Actual null and the forecast total
                  (the same per-item EAC rule as the metrics) spread
                  linearly by elapsed days, capped at that total. The
                  oracle walks the same calendar with date arithmetic
                  (month overflow by the 1st-of-month plus day-offset
                  rule), counts days by subtraction, and rounds with
                  floor(x + 0.5). Every golden pins the EXACT point list.
                  Without an asOf a wholly past window is all actuals and a
                  wholly future one all projection. Every point carries
                  windowEnd false except the closing point below.

  closing point   (EC5-9b, owner decision 2026-09-15.) A curve that has any
                  point closes on the window END date: its label is the UTC
                  day of month, a space and the month label ("30 Nov 27"),
                  Planned is the budget total rounded, Forecast is the
                  estimate at completion rounded (the same per-item rule),
                  and Actual is the invoice total dated on or before the end
                  when the end is on or before the actual-to-date cut, else
                  null; windowEnd is true. When a monthly step falls ON the
                  end date the closing point takes its place, so no date is
                  listed twice. The point of the rule: the last Planned is
                  the budget and the last Forecast the EAC, so an overrun
                  draws as an overrun.

  line forecast   (EC5-1 and the negative-forecast decision, owner
                  2026-09-15.) Per cost item, committed = actual +
                  commitment. A positive entered forecast IS the EAC even
                  below committed (a re-baseline), and the line is then
                  flagged forecastBelowCommitted true with
                  forecastBelowCommittedBy = committed minus the forecast
                  (else false and 0; equal is not below). An entered
                  forecast that is a number below 0 is ignored for the EAC
                  (the standard rule applies) and flagged forecastIgnored
                  'negative'; a zero, blank or non-numeric forecast is no
                  forecast and carries forecastIgnored null. The metrics
                  list every line in order as lineForecasts (index; label =
                  code, else description, else index; forecast; committed;
                  the three flag fields) and count the flagged lines as
                  linesForecastBelowCommitted and linesForecastIgnored.

  calculateEVM    PV as the sum of planned cost, EV as planned cost times
                  percent complete, AC as the actual sum; CPI and SPI with
                  the module's zero rules (1 when the divisor is zero and
                  the numerator positive, else 0); every figure rendered
                  with toFixed(2) as the module does, including the "NaN"
                  and "Infinity" strings a zero planned value produces.

Timezone: the S-curve is defined in UTC throughout (EC5-5, owner decision
2026-09-15): the window, asOf (a date-only asOf is that day's UTC
midnight), the monthly step, the day count and the label. This oracle works
on calendar dates, so it has no zone, and the gate replays the engine under
five TZ values and requires the same points. The metrics goldens assume a
UTC run, as the dates gate asserts.

Units: money is whatever the caller's currency is (the AFE app passes its
own); percentages 0 to 100; days are whole days.

stdlib only. Regenerate:
    python3 tools/validation/economics/oracle_afe.py
"""
import json
import math
import os
from datetime import date, datetime, timedelta
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
    sentences = []
    negatives = 0
    for idx, p in enumerate(partners):
        wi = js_number(p.get('working_interest'))
        if wi == wi and not math.isinf(wi) and wi < 0:
            negatives += 1
            who = ('Partner "%s"' % p['name']) if p.get('name') is not None else ('Partner at index %d' % idx)
            sentences.append('%s has a negative working interest (%s percent).' % (who, js_to_fixed_2(wi)))
    if negatives:
        sentences.append('Correct the interests before billing.')
    if operator_share < 0:
        sentences.append('Partner working interests total %s percent, which is more than the whole. The operator share below is '
                         'negative; correct the interests before billing.' % js_to_fixed_2(partner_total))
    note = ' '.join(sentences) if sentences else None
    allocated = sum(a['shareAmount'] for a in allocations) + operator_amount
    return {'partnerAllocations': allocations, 'operatorShare': operator_share, 'operatorAmount': operator_amount,
            'partnerTotal': partner_total, 'valid': operator_share >= 0 and negatives == 0, 'note': note,
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


def parse_as_of(s):
    """asOf as a UTC datetime: a date-only ISO string is midnight, a
    date-time string ending Z is that instant; anything else invalid (None)."""
    if not isinstance(s, str):
        return None
    try:
        if 'T' in s:
            if not s.endswith('Z'):
                return None
            return datetime.fromisoformat(s[:-1])
        d = date.fromisoformat(s)
        return datetime(d.year, d.month, d.day)
    except ValueError:
        return None


def midnight(d):
    return datetime(d.year, d.month, d.day)


def window_kind(afe, as_of=None):
    start, end = iso_date((afe or {}).get('start_date')), iso_date((afe or {}).get('end_date'))
    if start is None or end is None:
        return 'none', None, None
    if as_of is not None:
        return 'asOf', start, end
    if end <= PAST_LIMIT and start <= PAST_LIMIT:
        return 'past', start, end
    if start >= FUTURE_LIMIT and end >= FUTURE_LIMIT:
        return 'future', start, end
    raise ValueError('golden AFE windows without an asOf must be wholly past or wholly future: %r' % afe)


def time_progress(afe, as_of=None):
    kind, start, end = window_kind(afe, as_of)
    if kind == 'none':
        return 1.0
    if kind == 'future':
        return 0.0
    if kind == 'past':
        return 1.0
    s, e = midnight(start), midnight(end)
    if as_of < s:
        return 0.0
    if as_of > e:
        return 1.0
    total = (e - s) // timedelta(days=1)
    elapsed = (as_of - s) // timedelta(days=1)
    return elapsed / total if total > 0 else 1.0


def item_eac(i):
    f = num_or0(i.get('forecast'))
    return f if f > 0 else max(num_or0(i.get('budget')), num_or0(i.get('actual')) + num_or0(i.get('commitment')))


def line_forecast(idx, i):
    """EC5-1 and the negative-forecast flag, from the method statement."""
    entered = num_or0(i.get('forecast'))
    committed = num_or0(i.get('actual')) + num_or0(i.get('commitment'))
    below = entered > 0 and entered < committed
    label = i.get('code') if i.get('code') is not None else (i.get('description') if i.get('description') is not None else idx)
    return {'index': idx, 'label': label, 'forecast': item_eac(i), 'committed': committed,
            'forecastBelowCommitted': below,
            'forecastBelowCommittedBy': committed - entered if below else 0.0,
            'forecastIgnored': 'negative' if entered < 0 else None}


def js_num_str(x):
    """String(number) for the values the refusal cases carry."""
    if math.isinf(x):
        return 'Infinity' if x > 0 else '-Infinity'
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    return repr(x)


def refusal(items, as_of_raw):
    """The AfeInputError message the module must throw, or None."""
    if parse_as_of(as_of_raw) is None:
        return 'asOf is not a valid date'
    for idx, i in enumerate(items):
        pr = js_number(i.get('progress'))
        if pr != pr or 0 <= pr <= 100:
            continue
        label = i.get('code') if i.get('code') is not None else (i.get('description') if i.get('description') is not None else idx)
        side = 'negative progress' if pr < 0 else 'progress above 100 percent'
        return ('Cost item "%s" has %s (%s percent). Progress runs from 0 to 100 percent.'
                % (label, side, js_num_str(pr)))
    return None


def metrics(afe, items, invoices=None, as_of=None):
    bac = sum(num_or0(i.get('budget')) for i in items)
    commitments = sum(num_or0(i.get('commitment')) for i in items)
    ac = sum(num_or0(i.get('actual')) for i in items)
    eac = sum(item_eac(i) for i in items)
    vac = bac - eac
    ev = 0.0
    if bac > 0:
        ev = sum(num_or0(i.get('budget')) * (num_or0(i.get('progress')) / 100.0) for i in items)
    tp = time_progress(afe, as_of)
    pv = bac * tp
    # An undefined ratio is null, with the reason named (EC5-3, CPI item).
    cpi, cpi_status = (ev / ac, 'ok') if ac > 0 else (None, 'no-spend')
    if not bac > 0:
        spi, spi_status = None, 'no-budget'
    elif not pv > 0:
        spi, spi_status = None, 'no-planned-value'
    else:
        spi, spi_status = ev / pv, 'ok'
    undated = sum(1 for inv in (invoices or []) if iso_date(inv.get('invoice_date')) is None)
    lines = [line_forecast(k, i) for k, i in enumerate(items)]
    out = {'undatedInvoices': undated,
           'totalBudget': bac, 'totalCommitments': commitments, 'totalActuals': ac, 'totalForecast': eac,
           'variance': vac, 'earnedValue': ev, 'cpi': cpi, 'cpiStatus': cpi_status,
           'spi': spi, 'spiStatus': spi_status,
           'percentSpent': ac / bac * 100.0 if bac > 0 else 0.0,
           'percentComplete': ev / bac * 100.0 if bac > 0 else 0.0,
           'plannedValue': pv, 'timeProgress': tp,
           'lineForecasts': lines,
           'linesForecastBelowCommitted': sum(1 for x in lines if x['forecastBelowCommitted']),
           'linesForecastIgnored': sum(1 for x in lines if x['forecastIgnored'] is not None),
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


def display_day(d):
    return '%d %s' % (d.day, display(d))


def scurve(afe, items, invoices, as_of=None):
    kind, start, end = window_kind(afe, as_of)
    if kind == 'none':
        return {'kind': kind, 'points': [], 'totalBudget': None, 'totalForecast': None, 'totalDays': None}
    bac = sum(num_or0(i.get('budget')) for i in items)
    # The same per-item EAC rule as the metrics (EC5-0).
    eac = sum(item_eac(i) for i in items)
    # The actual-to-date cut: asOf, or the whole window for a wholly past
    # window without one, or nothing for a wholly future one.
    if kind == 'asOf':
        cut = as_of
    elif kind == 'past':
        cut = datetime.max
    else:
        cut = datetime.min
    total_days = (end - start).days
    daily_budget = bac / max(total_days, 1)
    daily_forecast = eac / max(total_days, 1)
    # EC6-1 (FINDINGS-fdp.md section 8, RESOLVED). An invoice with no date
    # the engine can read is not placed on the curve at all. A NULL date
    # used to be `new Date(null)`, the first of January 1970, so an undated
    # invoice counted in EVERY bucket and inflated the actual spend from the
    # first day of the AFE.
    dated = []
    for inv in invoices:
        d = iso_date(inv.get('invoice_date'))
        if d is not None:
            dated.append((d, js_number(inv.get('amount'))))
    points = []
    cur = start
    while cur <= end:
        elapsed = (cur - start).days
        planned = min(bac, elapsed * daily_budget)
        if midnight(cur) <= cut:
            actual = sum(a for d, a in dated if d <= cur)
            points.append({'date': display(cur), 'Planned': js_round(planned), 'Actual': js_round(actual), 'Forecast': js_round(actual), 'windowEnd': False})
        else:
            forecast = min(eac, elapsed * daily_forecast)
            points.append({'date': display(cur), 'Planned': js_round(planned), 'Actual': None, 'Forecast': js_round(forecast), 'windowEnd': False})
        last = cur
        cur = add_month_js(cur)
    # EC5-9b: the closing point at the window end.
    retired_last = dict(points[-1]) if points else None
    if points:
        if last == end:
            points.pop()
        end_actual = sum(a for d, a in dated if d <= end)
        points.append({'date': display_day(end), 'Planned': js_round(bac),
                       'Actual': js_round(end_actual) if midnight(end) <= cut else None,
                       'Forecast': js_round(eac), 'windowEnd': True})
    return {'kind': kind, 'points': points, 'totalBudget': bac,
            'totalForecast': eac, 'totalDays': float(total_days),
            # What the retired walk ended on (EC5-9b negative control): its
            # last monthly point, before the closing point existed.
            'retiredLastPoint': retired_last}


# ---------------------------------------------------------------------
# Project controls.
# ---------------------------------------------------------------------


class EvmRefused(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def _task_label(t, i):
    return t.get('name') or t.get('id') or 'task %d' % (i + 1)


def _read_cost(v, field, label):
    if v is None or v == '':
        return 0.0
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise EvmRefused('%s: %s is not a number: %s' % (label, field, v))
    if n != n or n in (INF, -INF):
        raise EvmRefused('%s: %s is not a number: %s' % (label, field, v))
    if n < 0:
        raise EvmRefused('%s: %s may not be negative: %s' % (label, field, js_num(n)))
    return n


def _read_percent(v, label):
    if v is None or v == '':
        return 0.0
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise EvmRefused('%s: percent complete is not a number: %s' % (label, v))
    if n != n or n < 0 or n > 100:
        raise EvmRefused('%s: percent complete must be between 0 and 100, not %s' % (label, js_num(n)))
    return n


def js_num(n):
    """How JavaScript prints a number in a template string."""
    if float(n).is_integer() and abs(n) < 1e21:
        return '%d' % int(n)
    return repr(float(n))


def _calendar_day(iso):
    """A date-only string as whole days since the epoch, or None."""
    if not isinstance(iso, str) or not iso.strip():
        return None
    try:
        d = date.fromisoformat(iso.strip()[:10])
    except ValueError:
        return None
    return (d - date(1970, 1, 1)).days


def _elapsed_fraction(task, as_of_day, label):
    start = _calendar_day(task.get('planned_start_date'))
    end = _calendar_day(task.get('planned_end_date'))
    if start is None or end is None:
        return None
    if end < start:
        raise EvmRefused('%s: the planned end date is before the planned start date' % label)
    if as_of_day <= start:
        return 0.0
    if as_of_day >= end:
        return 1.0
    return (as_of_day - start) / (end - start)


def evm(tasks, as_of='2026-09-15'):
    """EC6-1: planned value is TIME-PHASED to an as-of date.

    EC6-0 made the figures numbers, put null where an index has no
    denominator, and refused a cost it could not read. Planned value was
    still the whole budget of every task, so "SPI" was earned value over
    budget at completion: a project half done on time and a project half
    done a year late both read 0.50, and the index could never go above 1.
    Each task's budget is now spread evenly across its own planned window
    and cut off at the as-of date, the definition afe.js already uses. The
    completion ratio that number really was is still reported, by name."""
    as_of_day = _calendar_day(as_of)
    if as_of_day is None:
        raise EvmRefused('asOf is not a valid date: %s' % as_of)
    bac = ev = ac = pv = 0.0
    undated = 0
    for i, t in enumerate(tasks):
        label = _task_label(t, i)
        pc = _read_cost(t.get('planned_cost'), 'planned cost', label)
        pct = _read_percent(t.get('percent_complete'), label)
        bac += pc
        ev += pc * (pct / 100.0)
        ac += _read_cost(t.get('actual_cost'), 'actual cost', label)
        if pc > 0:
            fraction = _elapsed_fraction(t, as_of_day, label)
            if fraction is None:
                undated += 1
            else:
                pv += pc * fraction
    time_phased = bac > 0 and undated == 0
    if time_phased:
        basis = 'planned value time-phased to the as-of date'
    elif bac == 0:
        basis = 'no costed task, so there is no planned value'
    else:
        basis = ('%d costed task%s no planned dates, so planned value cannot be time-phased'
                 % (undated, ' carries' if undated == 1 else 's carry'))
    return {'plannedValue': pv if time_phased else None,
            'budgetAtCompletion': bac,
            'earnedValue': ev, 'actualCost': ac,
            'pv': pv if time_phased else None, 'ev': ev, 'ac': ac, 'bac': bac,
            'cpi': None if ac == 0 else ev / ac,
            'spi': (ev / pv) if (time_phased and pv > 0) else None,
            'cv': ev - ac, 'sv': (ev - pv) if time_phased else None,
            'completionRatio': None if bac == 0 else ev / bac,
            'percentComplete': None if bac == 0 else ev / bac * 100.0,
            'taskCount': len(tasks), 'costed': bac > 0,
            'undatedCostedTasks': undated,
            'asOf': as_of,
            'spiBasis': basis}


def cpi_spi(ev, divisor):
    if divisor == 0:
        return None
    return ev / divisor


def gantt_date(s):
    """EC6-0: the LOCAL calendar date a Gantt row carries, or None.

    The engine used to hand the chart `new Date('2026-03-01')`, which is UTC
    midnight: rendered in Los Angeles that row started on Feb 28, so a task
    moved a day by being looked at from another time zone. A date-only
    string is now local midnight, and null or unreadable is null rather
    than the epoch or an Invalid Date. Emitted as a calendar date so the
    gate can assert it in any zone."""
    if s == '__undefined__' or s is None:
        return None
    d = iso_date(s)
    return None if d is None else d.isoformat()


def gantt(tasks, project):
    out = []
    for t in tasks:
        row = {'id': t.get('id'), 'name': t.get('name'),
               'startDate': gantt_date(t.get('planned_start_date', '__undefined__')),
               'endDate': gantt_date(t.get('planned_end_date', '__undefined__')),
               'progress': t.get('percent_complete') if truthy(t.get('percent_complete')) else 0,
               'type': 'milestone' if t.get('type') == 'milestone' else 'task',
               'project': project.get('name'), 'isDisabled': False,
               'styles': {'progressColor': '#84cc16', 'progressSelectedColor': '#65a30d'},
               'owner': t.get('owner'), 'status': t.get('status'),
               'task_category': t.get('task_category')}
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
AFE_2YR = {'start_date': '2026-01-01', 'end_date': '2027-12-31', 'currency': 'USD'}
PARTNERS = [{'name': 'A', 'working_interest': 30}, {'name': 'B', 'working_interest': 15}]
# The EC5 course's teaching AFE (OFON-1), where EC5-9b was found.
OFON_AFE = {'afe_number': 'OFON-1', 'start_date': '2027-02-01', 'end_date': '2027-11-30', 'currency': 'USD'}
OFON_ITEMS = [
    {'code': 'DRL-01', 'description': 'Rig and drilling services', 'budget': 14200000, 'commitment': 2600000, 'actual': 9800000, 'progress': 72},
    {'code': 'CSG-02', 'description': 'Casing and tubulars', 'budget': 3900000, 'commitment': 0, 'actual': 4300000, 'progress': 100},
    {'code': 'CMT-03', 'description': 'Cementing', 'budget': 1250000, 'commitment': 300000, 'actual': 640000, 'forecast': 1400000, 'progress': 55},
    {'code': 'LOG-04', 'description': 'Logging and testing', 'budget': 2100000, 'commitment': 900000, 'actual': 350000, 'progress': 20},
    {'code': 'CMP-05', 'description': 'Completion', 'budget': 5600000, 'commitment': 1200000, 'actual': 0, 'progress': 0},
]
OFON_INVOICES = [
    {'invoice_date': '2027-02-20', 'amount': 3100000},
    {'invoice_date': '2027-04-10', 'amount': 5200000},
    {'invoice_date': '2027-06-05', 'amount': 4400000},
    {'invoice_date': '2027-07-18', 'amount': 2390000},
]


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
        ('negative interest: refused, allocation still shown', 1000, [{'name': 'A', 'working_interest': 30}, {'name': 'B', 'working_interest': -20}]),
        ('negative interest and a total over 100: both sentences, negative first', 1000, [{'name': 'A', 'working_interest': 130}, {'name': 'B', 'working_interest': -10}]),
        ('two negative interests, one unnamed, as a string', 500, [{'name': 'A', 'working_interest': '-5'}, {'working_interest': -2.5}, {'name': 'C', 'working_interest': 40}]),
    ]
    return [{'name': n, 'inputs': {'totalCost': c, 'partners': p}, 'expected': partner_split(c, p)} for n, c, p in sets]


def metrics_cases():
    sets = [
        ('suite test: sums', AFE_PAST, [{'budget': 100, 'commitment': 20, 'actual': 30, 'progress': 0}, {'budget': 200, 'commitment': 50, 'actual': 40, 'progress': 0}], None),
        ('suite test: entered forecast (nothing spent: CPI null)', AFE_PAST, [{'budget': 100, 'commitment': 0, 'actual': 0, 'forecast': 140, 'progress': 0}], None),
        ('suite test: under budget forecasts the budget', AFE_PAST, [{'budget': 100, 'commitment': 10, 'actual': 20, 'progress': 0}], None),
        ('suite test: committed past the budget', AFE_PAST, [{'budget': 100, 'commitment': 60, 'actual': 70, 'progress': 0}], None),
        ('suite test: weighted earned value (value earned, nothing spent: CPI null)', AFE_PAST, [{'budget': 100, 'actual': 0, 'progress': 50}, {'budget': 300, 'actual': 0, 'progress': 20}],
         'The CPI item: 110 earned against no spend. Before, CPI was reported as 1.'),
        ('suite test: CPI 1.25', AFE_PAST, [{'budget': 200, 'actual': 80, 'progress': 50}], None),
        ('suite test: SPI 0.5 at the end of the window', AFE_PAST, [{'budget': 200, 'actual': 100, 'progress': 50}], None),
        ('suite test: empty AFE: no budget and no spend, so SPI and CPI are null', AFE_PAST, [],
         'EC5-3 and the CPI item: spiStatus no-budget and cpiStatus no-spend. Before, the zero-budget guard reported SPI 1 and CPI 1.'),
        ('suite test: missing numbers (no budget, no spend: both ratios null)', AFE_PAST, [{'budget': None, 'commitment': '__undefined__', 'actual': '', 'progress': 'x'}], None),
        ('no dates: time progress 1', {'currency': 'USD'}, [{'budget': 400, 'actual': 100, 'progress': 25}], None),
        ('invalid dates: time progress 1', {'start_date': 'not a date', 'end_date': '2020-13-01'}, [{'budget': 400, 'actual': 100, 'progress': 25}], None),
        ('half a date: time progress 1', {'start_date': '2020-01-01'}, [{'budget': 400, 'actual': 100, 'progress': 25}], None),
        ('future window with progress: SPI is null', AFE_FUTURE, [{'budget': 400, 'actual': 100, 'progress': 25}],
         'Time progress is 0 so planned value is 0 and SPI is undefined: null. Before EC5-0 the engine reported Infinity.'),
        ('future window with no progress: SPI is null', AFE_FUTURE, [{'budget': 400, 'actual': 100, 'progress': 0}],
         'Planned value 0 and earned value 0: SPI null. Before EC5-0 the engine reported NaN.'),
        ('future window, zero budget: SPI null, no budget', AFE_FUTURE, [{'budget': 0, 'actual': 100, 'progress': 0}],
         'EC5-3: spiStatus no-budget. Before, the zero-budget guard reported SPI 1 while a budget with zero planned value reported null.'),
        ('negative entered forecast is ignored (the S-curve ignores it too)', AFE_PAST, [{'budget': 100, 'actual': 20, 'commitment': 0, 'forecast': -50, 'progress': 10}],
         'A forecast that is not positive falls through to max(budget, actual + commitment), in the metrics and the S-curve alike (itemForecast). Before EC5-0 the S-curve took the entered -50.'),
        ('strings everywhere', AFE_PAST, [{'budget': '1000', 'commitment': '250', 'actual': '300', 'forecast': '1100', 'progress': '40'}], None),
        ('overspent and overcommitted', AFE_PAST, [{'budget': 100, 'commitment': 80, 'actual': 150, 'progress': 100}, {'budget': 50, 'commitment': 0, 'actual': 0, 'progress': 0}], None),
        ('progress of exactly 100 percent is accepted and earns the whole budget', AFE_PAST, [{'budget': 100, 'actual': 90, 'progress': 100}, {'budget': 40, 'actual': 10, 'progress': '100'}], None),
        ('a dozen items', AFE_PAST, [{'budget': 100 * (k + 1), 'commitment': 10 * k, 'actual': 30 * k, 'progress': 8 * k, 'forecast': 0} for k in range(12)], None),
        ('zero budget with actuals: percent spent 0 by the guard, SPI null', AFE_PAST, [{'budget': 0, 'actual': 500, 'progress': 50}],
         'EC5-3: no budget, so spiStatus no-budget (SPI was 1). Spend with nothing earned gives a defined CPI of 0.'),
        ('value earned with no spend: CPI null', AFE_PAST, [{'budget': 1000, 'actual': 0, 'commitment': 400, 'progress': 40}],
         'The CPI item: 400 earned, 0 spent, so cpiStatus no-spend; SPI is defined (0.4).'),
        ('EC5-1: a forecast below the money spent and committed is kept and flagged', AFE_PAST,
         [{'code': 'RIG', 'budget': 1000, 'actual': 700, 'commitment': 200, 'forecast': 850, 'progress': 60},
          {'code': 'CMT', 'budget': 300, 'actual': 100, 'commitment': 50, 'forecast': 400, 'progress': 30}],
         'EC5-1: RIG forecasts 850 against 900 already spent and committed. The 850 stays the EAC (a re-baseline is legitimate) and the line is flagged below committed by 50. Before, it was taken silently.'),
        ('EC5-1: a forecast equal to the money committed is not below it', AFE_PAST,
         [{'description': 'Casing', 'budget': 500, 'actual': 300, 'commitment': 100, 'forecast': 400, 'progress': 50}], None),
        ('EC5-1: string inputs, forecast 1100 below 1200 committed', AFE_PAST,
         [{'budget': '1000', 'actual': '900', 'commitment': '300', 'forecast': '1100', 'progress': '70'}], None),
        ('negative forecast flag: only a number below 0 is flagged; blank, zero and text are no forecast', AFE_PAST,
         [{'code': 'A', 'budget': 100, 'actual': 20, 'forecast': -50, 'progress': 10},
          {'code': 'B', 'budget': 100, 'forecast': '', 'progress': 0},
          {'code': 'C', 'budget': 100, 'forecast': 0, 'progress': 0},
          {'code': 'D', 'budget': 100, 'forecast': 'abc', 'progress': 0},
          {'description': 'E', 'budget': 100, 'actual': 130, 'forecast': '-0.5', 'progress': 0},
          {'budget': 100, 'actual': 90, 'commitment': 30, 'forecast': 60, 'progress': 0}],
         'A and E are flagged forecastIgnored negative and take the standard rule (100 and 130); the unnamed line 5 forecasts 60 against 120 committed and is flagged below committed by 60. Before, the negative values were ignored silently.'),
    ]
    probe = [{'budget': 1000, 'actual': 300, 'progress': 40}]
    as_of_sets = [
        ('asOf mid-window: SPI against 256 of 729 days', AFE_2YR, probe, '2026-09-14', 'Date', None),
        ('asOf as a string, later in the window', AFE_2YR, probe, '2027-03-01', 'string', None),
        ('asOf with a time of day counts whole days only', AFE_2YR, probe, '2026-09-14T15:30:00Z', 'Date', None),
        ('asOf before the start: SPI null', AFE_2YR, [{'budget': 400, 'actual': 100, 'progress': 25}], '2025-12-31', 'Date',
         'Planned value is 0 before the start, so SPI is undefined: null.'),
        ('asOf before the start with no progress or spend: SPI and CPI null', AFE_2YR, [{'budget': 400, 'actual': 0, 'progress': 0}], '2025-06-01', 'string', None),
        ('asOf on the start day: no whole day elapsed, SPI null', AFE_2YR, probe, '2026-01-01', 'Date', None),
        ('asOf on the end day: time progress 1', AFE_2YR, probe, '2027-12-31', 'Date', None),
        ('asOf after the end: time progress 1', AFE_2YR, [{'budget': 600, 'actual': 700, 'commitment': 50, 'progress': 90}, {'budget': 400, 'actual': 100, 'progress': 100}], '2028-06-30', 'string', None),
        ('asOf before the start, zero budget: SPI null, no budget', AFE_2YR, [{'budget': 0, 'actual': 100, 'progress': 0}], '2025-01-01', 'Date',
         'EC5-3: spiStatus no-budget ahead of no-planned-value. Before, the zero-budget guard reported SPI 1.'),
        ('asOf with no AFE dates: time progress 1', {'currency': 'USD'}, probe, '2026-09-14', 'Date', None),
        ('EC5-1 and EC5-9b: OFON-1 at 2027-08-15, no line below committed', OFON_AFE, OFON_ITEMS, '2027-08-15', 'string', None),
        ('asOf mid-window, a dozen items with forecasts', AFE_2YR, [{'budget': 100 * (k + 1), 'commitment': 10 * k, 'actual': 30 * k, 'progress': 7 * k, 'forecast': (0 if k % 3 else 150 * (k + 1))} for k in range(12)], '2027-06-15', 'string', None),
    ]
    out = []
    for n, afe, items, note in sets:
        items_js = [{k: v for k, v in i.items() if v != '__undefined__'} for i in items]
        assert refusal(items_js, '2026-01-01') is None
        c = {'name': n, 'inputs': {'afe': afe, 'costItems': items_js, 'invoices': []}, 'expected': metrics(afe, items_js)}
        if note:
            c['note'] = note
        out.append(c)
    for n, afe, items, as_of, as_of_as, note in as_of_sets:
        assert refusal(items, as_of) is None
        c = {'name': n, 'inputs': {'afe': afe, 'costItems': items, 'invoices': [], 'asOf': as_of, 'asOfAs': as_of_as},
             'expected': metrics(afe, items, as_of=parse_as_of(as_of))}
        if note:
            c['note'] = note
        out.append(c)
    return out


def metrics_refusal_cases():
    sets = [
        ('invalid asOf: not a date', AFE_2YR, [{'budget': 100, 'progress': 10}], 'not a date'),
        ('invalid asOf: month 13', AFE_2YR, [{'budget': 100, 'progress': 10}], '2026-13-01'),
        ('invalid asOf: 30 February', AFE_2YR, [{'budget': 100, 'progress': 10}], '2026-02-30'),
        ('invalid asOf is refused even with no AFE dates', {}, [], 'yesterday'),
        ('negative progress named by code', AFE_2YR, [{'code': 'DRL-01', 'description': 'Drilling', 'budget': 1000, 'actual': 0, 'progress': 10}, {'code': 'CMP-02', 'budget': 1000, 'actual': 0, 'progress': -20}], '2026-09-14'),
        ('negative progress named by description', AFE_2YR, [{'description': 'Completion', 'budget': 500, 'progress': -0.5}], '2026-09-14'),
        ('negative progress as a string, named by index', AFE_2YR, [{'budget': 100, 'progress': 10}, {'budget': 100, 'progress': '-12.5'}], '2026-09-14'),
        # EC5-8: the former golden "progress beyond 100 percent earns beyond the budget".
        ('progress beyond 100 percent is refused', AFE_PAST, [{'budget': 100, 'actual': 90, 'progress': 150}], '2020-12-31'),
        ('progress 100.5 as a string, named by description', AFE_2YR, [{'description': 'Hook-up', 'budget': 500, 'progress': '100.5'}], '2026-09-14'),
        ('progress over 100 named by code, ahead of a later negative item', AFE_2YR, [{'code': 'FAB-01', 'budget': 800, 'progress': 120}, {'code': 'INS-02', 'budget': 200, 'progress': -5}], '2026-09-14'),
        ('infinite progress is above 100', AFE_2YR, [{'code': 'X9', 'budget': 100, 'progress': 'Infinity'}], '2026-09-14'),
    ]
    out = []
    for n, afe, items, as_of in sets:
        msg = refusal(items, as_of)
        assert msg is not None, n
        out.append({'name': n, 'inputs': {'afe': afe, 'costItems': items, 'invoices': [], 'asOf': as_of},
                    'expected': {'error': 'AfeInputError', 'message': msg}})
    return out


def scurve_cases():
    inv = [{'invoice_date': '2020-02-15', 'amount': 100}, {'invoice_date': '2020-06-15', 'amount': 250}]
    sets = [
        ('suite test: no dates', {}, [{'budget': 100}], []),
        ('suite test: 1200 over 2020, no invoices', AFE_PAST, [{'budget': 1200}], []),
        ('suite test: 1200 over 2020 with two invoices', AFE_PAST, [{'budget': 1200}], inv),
        ('past window, invoices on bucket boundaries', AFE_PAST, [{'budget': 3650}], [{'invoice_date': '2020-01-01', 'amount': 10}, {'invoice_date': '2020-03-01', 'amount': 20}, {'invoice_date': '2020-12-31', 'amount': 30}]),
        ('past window, invoice dated after the window never counts', AFE_PAST, [{'budget': 1200}], [{'invoice_date': '2020-06-15', 'amount': 250}, {'invoice_date': '2021-03-01', 'amount': 100}]),
        ('past window, string amounts', AFE_PAST, [{'budget': '600', 'actual': '50'}], [{'invoice_date': '2020-04-10', 'amount': '250'}, {'invoice_date': '2020-04-11', 'amount': ''}]),
        ('past window, month-end start overflows the buckets', {'start_date': '2020-01-31', 'end_date': '2020-12-31'}, [{'budget': 1000}], inv),
        ('past window, zero budget', AFE_PAST, [{'budget': 0}], inv),
        ('past window, all invoices unpaid: none dated', AFE_PAST, [{'budget': 1200}], [{'amount': 100}, {'invoice_date': None, 'amount': 200}]),
        ('past window of one day', {'start_date': '2020-06-15', 'end_date': '2020-06-15'}, [{'budget': 500}], [{'invoice_date': '2020-06-15', 'amount': 500}]),
        ('future window: planned and forecast projected, actual null', AFE_FUTURE, [{'budget': 1200, 'commitment': 100, 'actual': 200}], []),
        ('future window with an entered forecast', AFE_FUTURE, [{'budget': 1200, 'forecast': 1500}], []),
        ('future window with a NEGATIVE entered forecast, ignored as in the metrics', AFE_FUTURE, [{'budget': 1200, 'forecast': -50}], []),
        ('future window, end before start: no points', {'start_date': '2090-12-31', 'end_date': '2090-01-01'}, [{'budget': 1200}], []),
        ('future window of one day', {'start_date': '2090-06-15', 'end_date': '2090-06-15'}, [{'budget': 500}], []),
        ('future window, Jan 31 start', {'start_date': '2091-01-31', 'end_date': '2091-12-31'}, [{'budget': 1000}], []),
        ('future two-year window', {'start_date': '2090-03-01', 'end_date': '2092-02-29'}, [{'budget': 730, 'forecast': 800}], []),
        ('future window ending on a bucket: the last forecast point is the whole EAC', {'start_date': '2090-01-01', 'end_date': '2091-01-01'}, [{'budget': 1200, 'actual': 900, 'commitment': 600}, {'budget': 500, 'forecast': 650}, {'budget': 300, 'forecast': -10}], []),
    ]
    as_of_sets = [
        ('past window, asOf mid-year: actuals to June, forecast projected after', AFE_PAST, [{'budget': 1200, 'actual': 200, 'commitment': 100, 'forecast': 1500}], inv, '2020-06-30'),
        ('past window, asOf on a bucket day counts that bucket', AFE_PAST, [{'budget': 1200}], inv, '2020-06-01'),
        ('past window, asOf before the start: no actuals at all', AFE_PAST, [{'budget': 1200}], inv, '2019-06-01'),
        ('future window, asOf after the end: all actuals', AFE_FUTURE, [{'budget': 1200}], [{'invoice_date': '2090-03-10', 'amount': 400}, {'invoice_date': '2091-01-10', 'amount': 99}], '2095-01-01'),
        ('window spanning today, asOf 2026-09-14', AFE_2YR, [{'budget': 2400, 'actual': 900, 'commitment': 300}], [{'invoice_date': '2026-02-15', 'amount': 300}, {'invoice_date': '2026-08-20', 'amount': 600}, {'invoice_date': '2026-10-01', 'amount': 50}], '2026-09-14'),
        ('negative entered forecast with asOf: ignored, never a negative point', AFE_2YR, [{'budget': 1200, 'forecast': -50}], [], '2026-05-01'),
        # EC5-5: a window opening on 1 February. Drawn in Los Angeles before the
        # repair its first label read "Jan 27" and every Planned value moved.
        ('February start labels Feb in every zone, asOf mid-window', {'start_date': '2027-02-01', 'end_date': '2028-01-31'}, [{'budget': 3650, 'actual': 700, 'commitment': 200}], [{'invoice_date': '2027-02-01', 'amount': 150}, {'invoice_date': '2027-05-31', 'amount': 250}, {'invoice_date': '2027-11-15', 'amount': 90}], '2027-06-01'),
        ('window across both clock changes, asOf on the November bucket', {'start_date': '2026-03-01', 'end_date': '2027-03-01'}, [{'budget': 1000}], [{'invoice_date': '2026-03-08', 'amount': 40}, {'invoice_date': '2026-11-01', 'amount': 60}], '2026-11-01'),
        # EC5-9b: the teaching AFE. The retired walk ended on Nov 27 with
        # Forecast 24949669 below the budget 27050000 while the EAC is 27600000.
        ('EC5-9b: OFON-1 at 2027-08-15 closes on 30 Nov 27 with Planned the budget and Forecast the EAC', OFON_AFE, OFON_ITEMS, OFON_INVOICES, '2027-08-15'),
        ('EC5-9b: OFON-1 read after the end: the closing point carries the actuals and the EAC', OFON_AFE, OFON_ITEMS, OFON_INVOICES, '2028-01-10'),
        ('EC5-9b: asOf on the end day counts an invoice dated that day on the closing point', {'start_date': '2026-01-15', 'end_date': '2026-06-20'}, [{'budget': 900, 'actual': 700, 'commitment': 400}], [{'invoice_date': '2026-03-01', 'amount': 300}, {'invoice_date': '2026-06-20', 'amount': 450}], '2026-06-20'),
        ('EC5-9b: a window ending on a month step, read after the end: the step becomes the closing point', {'start_date': '2026-01-01', 'end_date': '2026-05-01'}, [{'budget': 400, 'forecast': 380, 'actual': 500}], [{'invoice_date': '2026-05-01', 'amount': 120}], '2026-05-02'),
    ]
    out = []
    for n, afe, items, invs in sets:
        c = {'name': n, 'inputs': {'afe': afe, 'costItems': items, 'invoices': invs}, 'expected': scurve(afe, items, invs)}
        out.append(c)
    for n, afe, items, invs, as_of in as_of_sets:
        c = {'name': n, 'inputs': {'afe': afe, 'costItems': items, 'invoices': invs, 'asOf': as_of},
             'expected': scurve(afe, items, invs, parse_as_of(as_of))}
        out.append(c)
    return out


def evm_cases():
    """EC6-1: every costed task carries a planned window, so planned value
    can be time-phased; the cases without one are here on purpose."""
    W = {'planned_start_date': '2026-01-01', 'planned_end_date': '2026-12-31'}
    sets = [
        ('three tasks', [dict(W, name='t1', planned_cost=1000, percent_complete=50, actual_cost=600),
                         dict(W, name='t2', planned_cost=2000, percent_complete=25, actual_cost=400),
                         dict(W, name='t3', planned_cost=500, percent_complete=100, actual_cost=450)], '2026-07-02', None),
        ('empty task list: no percent complete', [], '2026-07-02',
         'EC6-0: percentComplete is null. It used to be the string "NaN", and one card read that as 0 and printed "Behind Schedule".'),
        ('no actuals but progress: CPI is not defined',
         [dict(W, name='a', planned_cost=100, percent_complete=40, actual_cost=0)], '2026-07-02',
         'EC6-0: cpi is null. It used to be an invented 1.00, printed as "Under Budget".'),
        ('no actuals and no progress: CPI is not defined',
         [dict(W, name='a', planned_cost=100, percent_complete=0, actual_cost=0)], '2026-07-02', None),
        ('tasks without costs: no SPI', [{'name': 'x'}, {'name': 'y', 'actual_cost': 20}], '2026-07-02',
         'EC6-0: spi and percentComplete are null. This is every project in the app: no screen wrote a task cost until this wave.'),
        ('strings and blanks',
         [dict(W, name='a', planned_cost='1500.5', percent_complete='33.3', actual_cost='499.99'),
          dict(W, name='b', planned_cost='', percent_complete=None)], '2026-07-02', None),
        ('a tie at the third decimal: 0.125 rounds to 0.13',
         [dict(W, name='a', planned_cost=0.125, percent_complete=100, actual_cost=0.125)], '2026-07-02', None),
        ('negative cost variance rounds away from zero',
         [dict(W, name='a', planned_cost=10, percent_complete=100, actual_cost=10.125)], '2026-07-02', None),
        ('a single fully spent task',
         [dict(W, name='one', planned_cost=100, percent_complete=100, actual_cost=100)], '2026-07-02', None),
        ('over budget and behind',
         [dict(W, name='a', planned_cost=4000, percent_complete=30, actual_cost=2500)], '2026-07-02', None),
        ('twenty tasks', [dict(W, name='t%d' % k, planned_cost=100 + 37 * k, percent_complete=(k * 13) % 101,
                               actual_cost=90 + 41 * k) for k in range(20)], '2026-07-02', None),
        ('2.675 does not tie in binary',
         [dict(W, name='a', planned_cost=2.675, percent_complete=100, actual_cost=2.675)], '2026-07-02', None),
        # EC6-1 cases
        ('before the window opens: nothing is planned yet, so no SPI',
         [dict(W, name='a', planned_cost=1000, percent_complete=0)], '2025-12-31',
         'EC6-1: planned value is 0 before the start, so there is no schedule index to report.'),
        ('after the window closes: the whole budget was planned',
         [dict(W, name='a', planned_cost=1000, percent_complete=60)], '2027-06-30',
         'EC6-1: SPI is the completion ratio only once the window has closed.'),
        ('half way through a window, half done: on schedule',
         [dict(W, name='a', planned_cost=1000, percent_complete=50)], '2026-07-02', None),
        ('half way through a window, a quarter done: behind',
         [dict(W, name='a', planned_cost=1000, percent_complete=25)], '2026-07-02', None),
        ('two windows that do not overlap',
         [{'name': 'first', 'planned_cost': 600, 'percent_complete': 100,
           'planned_start_date': '2026-01-01', 'planned_end_date': '2026-06-30'},
          {'name': 'second', 'planned_cost': 400, 'percent_complete': 0,
           'planned_start_date': '2026-07-01', 'planned_end_date': '2026-12-31'}], '2026-07-01', None),
        ('a costed task with no dates: planned value cannot be time-phased',
         [dict(W, name='dated', planned_cost=500, percent_complete=50),
          {'name': 'undated', 'planned_cost': 500, 'percent_complete': 50}], '2026-07-02',
         'EC6-1: spi is null and the basis says why; the completion ratio is still reported.'),
        ('a zero-length window is either not started or finished',
         [{'name': 'milestone', 'planned_cost': 100, 'percent_complete': 100,
           'planned_start_date': '2026-06-01', 'planned_end_date': '2026-06-01'}], '2026-06-01', None),
    ]
    out = []
    for n, tasks, as_of, note in sets:
        c = {'name': n, 'inputs': {'tasks': tasks, 'asOf': as_of}, 'expected': evm(tasks, as_of)}
        if note:
            c['note'] = note
        out.append(c)
    return out


def evm_refusal_cases():
    """EC6-0: what calculateEVM now refuses instead of reading as zero."""
    out = []
    for name, tasks in [
        ('a cost pasted with its currency symbol', [{'name': 'Rig move', 'planned_cost': '$1,200'}]),
        ('a negative planned cost', [{'name': 'Credit', 'planned_cost': -100, 'percent_complete': 50}]),
        ('a negative actual cost', [{'name': 'Refund', 'planned_cost': 100, 'actual_cost': -20}]),
        ('progress over 100 percent', [{'name': 'Overdone', 'planned_cost': 100, 'percent_complete': 150}]),
        ('negative progress', [{'name': 'Back', 'planned_cost': 100, 'percent_complete': -10}]),
        ('an unreadable progress figure', [{'name': 'Half', 'planned_cost': 100, 'percent_complete': 'half'}]),
        ('an unnamed task is refused by its position', [{'planned_cost': 'abc'}]),
        ('a planned window that ends before it starts',
         [{'name': 'Backwards', 'planned_cost': 100, 'planned_start_date': '2026-06-30',
           'planned_end_date': '2026-01-01'}]),
    ]:
        try:
            evm(tasks, '2026-07-02')
        except EvmRefused as e:
            out.append({'name': name, 'inputs': {'tasks': tasks, 'asOf': '2026-07-02'},
                        'expected': {'refused': True, 'message': e.message}})
            continue
        raise AssertionError('expected a refusal for: %s' % name)
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
            'standard EVM set beside it (cv, sv, etc, tcpi are reference only, not engine outputs; plannedValue and '
            'timeProgress are engine outputs since EC5-0; since EC5-3 cpi and spi are null wherever the ratio is '
            'undefined, with cpiStatus no-spend and spiStatus no-budget or no-planned-value, and ok otherwise). '
            'metricsRefusals: the AfeInputError message for an invalid asOf or progress outside 0 to 100 percent. '
            'sCurve: the exact '
            'generateSCurveData point list, bounded to the window and closed on the window end date with Planned the '
            'budget and Forecast the EAC (EC5-9b; retiredLastPoint is where the walk ended before, for the negative '
            'control). metrics lineForecasts and the two flag counts: EC5-1 and the negative-forecast flag. inputs.asOf, when present, is passed to the '
            'engine (as a Date when inputs.asOfAs is "Date", else as the string). evm: '
            'projectControls.calculateEVM strings (toFixed(2)) and their numeric values; cpiSpi; gantt: '
            'formatTasksForGantt rows with dates as epoch milliseconds (null = Invalid Date). Independent stdlib '
            'oracle tools/validation/economics/oracle_afe.py. Cases without an asOf use AFE windows wholly past '
            '(2020) or wholly future (2090 or later), because the engine defaults asOf to the clock; they are '
            'valid until 2080. Money in the caller\'s currency; percentages 0 to 100; days whole. A null where a '
            'number is expected is a null in the engine too (spi), or a non-finite value where a note says so. '
            'The S-curve is UTC throughout (EC5-5) and the gate requires the same points under five TZ values; '
            'the metrics goldens assume a UTC run.'),
        'validUntil': FUTURE_LIMIT.isoformat(),
        'partnerSplit': partner_cases(),
        'metrics': metrics_cases(),
        'metricsRefusals': metrics_refusal_cases(),
        'sCurve': scurve_cases(),
        'evm': evm_cases(),
        'evmRefusals': evm_refusal_cases(),
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
