#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/calendar.js (AS12, group A).

Stdlib only. Written from the method statement in the module docstring,
not from the function bodies:

  * A calendar date is a 'YYYY-MM-DD' (or a string that BEGINS with one,
    or a Date, whose local calendar day is taken). Anything else, and
    any string that does not name a real day of the Gregorian calendar,
    is no date at all: "an unreadable date is no date, never today".
  * daysUntil is the signed number of whole calendar days from today to
    the date, None when there is no date. Python's datetime.date has no
    clock and no time zone, so date subtraction is the independent model
    of the JS local-midnight rounding across a daylight saving change.
  * toDateOnlyString renders the calendar date as YYYY-MM-DD.

This file also carries the small golden-writing toolkit the other group A
oracles import (tagged JSON values, JS Number() coercion, month
arithmetic with month-end clamping). None of it is engine logic.

Run:  python3 tools/validation/assurance/oracle_calendar.py
Writes test-data/assurance/goldens/calendar_cases.json
"""
import datetime as _dt
import json
import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN_DIR = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'test-data', 'assurance', 'goldens'))


# ---------------------------------------------------------------- tagged values

class D:
    """A JS Date at local midnight in an argument or an expectation. D(None) = Invalid Date."""
    def __init__(self, ymd):
        self.ymd = ymd


class _Undef:
    pass


UNDEF = _Undef()
NAN = float('nan')


def enc(v):
    """Python value -> golden JSON with the contract's tagged forms."""
    if isinstance(v, D):
        return {'$date': v.ymd}
    if isinstance(v, _dt.date):
        return {'$date': f'{v.year:04d}-{v.month:02d}-{v.day:02d}'}
    if isinstance(v, _Undef):
        return {'$undefined': True}
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, float) and not math.isfinite(v):
        return {'$num': 'NaN' if v != v else ('Infinity' if v > 0 else '-Infinity')}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    if isinstance(v, dict):
        return {k: enc(x) for k, x in v.items()}
    return v


class Cases:
    def __init__(self, module, generated_by, description):
        self.module = module
        self.generated_by = generated_by
        self.description = description
        self.cases = []
        self._ids = set()

    def _id(self, cid):
        assert cid not in self._ids, cid
        self._ids.add(cid)

    def add(self, cid, fn, args, expected, defect=None, prose=None):
        self._id(cid)
        c = {'id': cid, 'fn': fn, 'args': enc(list(args)), 'expected': enc(expected)}
        if defect:
            c['repaired'] = defect
        if prose:
            c['prose'] = prose  # 'exact': reason/text compared verbatim (ASC-0 RC-9)
        self.cases.append(c)

    def throws(self, cid, fn, args, defect=None):
        self._id(cid)
        c = {'id': cid, 'fn': fn, 'args': enc(list(args)), 'expectedThrows': True}
        if defect:
            c['repaired'] = defect
        self.cases.append(c)

    def sort(self, cid, name, rows, expected_order, factory_args=None, defect=None):
        self._id(cid)
        c = {'id': cid, 'sort': name, 'factory': factory_args is not None,
             'factoryArgs': enc(list(factory_args or [])), 'rows': enc(rows),
             'expectedOrder': list(expected_order)}
        if defect:
            c['repaired'] = defect
        self.cases.append(c)

    def write(self, filename):
        os.makedirs(GOLDEN_DIR, exist_ok=True)
        path = os.path.join(GOLDEN_DIR, filename)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'module': self.module, 'generatedBy': self.generated_by,
                       'description': self.description, 'cases': self.cases},
                      f, indent=1, ensure_ascii=False)
            f.write('\n')
        print(f'{path}: {len(self.cases)} cases, '
              f'{sum(1 for c in self.cases if c.get("repaired"))} repaired')


# ------------------------------------------------------------ English agreement
# ASC-0 (RC-9). For the few golden cases that compare a sentence verbatim
# ("prose": "exact"): the words are the engine's, the AGREEMENT is decided
# here, independently. Not engine logic.

def article(word):
    """'An' before a vowel letter, else 'A'."""
    return 'An' if str(word)[:1].lower() in 'aeiou' else 'A'


def listed(xs):
    """'x', 'x and y', 'x, y and z'."""
    xs = [str(x) for x in xs]
    return xs[0] if len(xs) == 1 else ', '.join(xs[:-1]) + ' and ' + xs[-1]


def agree(n, one, many):
    return one if n == 1 else many


# ------------------------------------------------------------ JS-ish coercions

_NUM = re.compile(r'[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?')


def js_number(v):
    """ECMAScript Number(v) for the input shapes the cases use."""
    if isinstance(v, _Undef):
        return NAN
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if s == '':
            return 0.0
        if _NUM.fullmatch(s):
            return float(s)
        if s in ('Infinity', '+Infinity'):
            return math.inf
        if s == '-Infinity':
            return -math.inf
        return NAN
    return NAN


def truthy(v):
    """JavaScript truthiness for the shapes the cases use."""
    if v is None or isinstance(v, _Undef) or v is False:
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return not (v == 0 or v != v)
    if isinstance(v, str):
        return v != ''
    if isinstance(v, D):
        return True
    return True


def pynum(x):
    """A float that is integral comes back as an int, for readable JSON."""
    if isinstance(x, float) and math.isfinite(x) and x == int(x):
        return int(x)
    return x


# ---------------------------------------------------------------- calendar

_YMD = re.compile(r'(\d{4})-(\d{2})-(\d{2})')


def to_date(v):
    """The calendar date a value names, or None. The oracle's parseDateOnly."""
    if not truthy(v):
        return None
    if isinstance(v, D):
        return to_date(v.ymd) if v.ymd else None
    if isinstance(v, _dt.date):
        return v
    if not isinstance(v, str):
        return None  # a number, an object: not a string that begins YYYY-MM-DD
    m = _YMD.match(v)
    if not m:
        return None
    try:
        return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None  # no such day: 30 February, month 13, year 0


def days_until(v, today):
    d = to_date(v)
    if d is None:
        return None
    return (d - to_date(today)).days


def ymd_string(v):
    d = to_date(v)
    return None if d is None else f'{d.year:04d}-{d.month:02d}-{d.day:02d}'


def add_months(d, months):
    """Calendar months forward, clamped to the last day of the target month."""
    idx = d.month - 1 + months
    y, m = d.year + idx // 12, idx % 12 + 1
    first_of_following = _dt.date(y + (m == 12), m % 12 + 1, 1)
    last = (first_of_following - _dt.timedelta(days=1)).day
    return _dt.date(y, m, min(d.day, last))


def date_key(d):
    return (0, d) if d is not None else (1, _dt.date.min)


def count_by(rows, field, unset='Unspecified'):
    """Rows grouped by a field, falsy -> unset, largest group first, ties in first-seen order."""
    counts = {}
    order = []
    for r in rows:
        key = r.get(field) if isinstance(r, dict) else None
        if not truthy(key):
            key = unset
        if key not in counts:
            counts[key] = 0
            order.append(key)
        counts[key] += 1
    ranked = sorted(order, key=lambda k: -counts[k])  # stable: ties keep first-seen order
    return [{'name': k, 'count': counts[k]} for k in ranked]


def date_family_cases(c, prefix, today):
    """Cases for the three calendar helpers a rule module re-exports."""
    c.add(f'{prefix}-parse-string', 'parseDateOnly', ['2026-09-17'], _dt.date(2026, 9, 17))
    c.add(f'{prefix}-parse-null', 'parseDateOnly', [None], None)
    c.add(f'{prefix}-parse-garbage', 'parseDateOnly', ['next week'], None)
    c.add(f'{prefix}-days-today', 'daysUntil', ['2026-09-17', today], 0)
    c.add(f'{prefix}-days-past', 'daysUntil', ['2026-09-10', today], -7)
    c.add(f'{prefix}-days-none', 'daysUntil', ['', today], None)
    c.add(f'{prefix}-ymd-date', 'toDateOnlyString', [D('2026-03-08')], '2026-03-08')
    c.add(f'{prefix}-ymd-nonsense', 'toDateOnlyString', ['nonsense'], None)


# ---------------------------------------------------------------- the golden

def build():
    c = Cases('calendar', 'tools/validation/assurance/oracle_calendar.py',
              'Calendar-date parsing and whole-day arithmetic, from the module docstring; '
              'Python datetime.date is the independent model of local-midnight rounding.')
    T = D('2026-09-17')

    # parseDateOnly: strings
    ok = {
        'parse-plain': '2026-09-17',
        'parse-leap-day': '2028-02-29',
        'parse-year-end': '2026-12-31',
        'parse-year-start': '2027-01-01',
        'parse-utc-timestamp-prefix': '2026-09-17T23:30:00Z',
        'parse-offset-timestamp-prefix': '2026-09-17T01:00:00+14:00',
        'parse-us-dst-start': '2026-03-08',
        'parse-nz-dst-end': '2026-04-05',
        'parse-nz-dst-start': '2026-09-27',
        'parse-us-dst-end': '2026-11-01',
    }
    for cid, s in ok.items():
        c.add(cid, 'parseDateOnly', [s], to_date(s))
    for cid, v in {
        'parse-null': None, 'parse-undefined': UNDEF, 'parse-empty': '',
        'parse-garbage': 'garbage', 'parse-dmy': '17/09/2026', 'parse-unpadded': '2026-9-7',
        'parse-leading-space': ' 2026-09-17', 'parse-number': 20260917, 'parse-zero': 0,
    }.items():
        c.add(cid, 'parseDateOnly', [v], None)
    # a Date is taken at its local calendar day
    c.add('parse-date-object', 'parseDateOnly', [D('2026-03-08')], _dt.date(2026, 3, 8))
    c.add('parse-invalid-date-object', 'parseDateOnly', [D(None)], None)
    # strings that match the shape but name no real day: no date (CAL-1)
    for cid, s in {
        'parse-feb-30': '2026-02-30', 'parse-feb-29-nonleap': '2026-02-29',
        'parse-apr-31': '2026-04-31', 'parse-month-13': '2026-13-01', 'parse-month-00': '2026-00-10',
        'parse-day-00': '2026-09-00',
    }.items():
        assert to_date(s) is None
        c.add(cid, 'parseDateOnly', [s], None, defect='CAL-1')

    # startOfDay
    c.add('startofday-date', 'startOfDay', [D('2026-03-08')], _dt.date(2026, 3, 8))
    c.add('startofday-invalid', 'startOfDay', [D(None)], D(None))

    # daysUntil
    spans = [
        ('days-same', '2026-09-17', '2026-09-17'),
        ('days-tomorrow', '2026-09-18', '2026-09-17'),
        ('days-yesterday', '2026-09-16', '2026-09-17'),
        ('days-across-us-dst-start', '2026-03-09', '2026-03-07'),
        ('days-on-us-dst-start', '2026-03-09', '2026-03-08'),
        ('days-into-us-dst-start', '2026-03-08', '2026-03-07'),
        ('days-backwards-us-dst', '2026-03-01', '2026-03-15'),
        ('days-across-us-dst-end', '2026-11-02', '2026-10-31'),
        ('days-on-us-dst-end', '2026-11-02', '2026-11-01'),
        ('days-across-nz-dst-end', '2026-04-06', '2026-04-04'),
        ('days-on-nz-dst-end', '2026-04-06', '2026-04-05'),
        ('days-across-nz-dst-start', '2026-09-28', '2026-09-26'),
        ('days-on-nz-dst-start', '2026-09-28', '2026-09-27'),
        ('days-whole-year', '2027-01-01', '2026-01-01'),
        ('days-leap-feb', '2028-03-01', '2028-02-28'),
        ('days-decade', '2030-01-01', '2020-01-01'),
        ('days-decade-back', '2020-01-01', '2030-01-01'),
        ('days-year-boundary', '2027-01-01', '2026-12-31'),
    ]
    for cid, target, today in spans:
        c.add(cid, 'daysUntil', [target, D(today)], days_until(target, D(today)))
    c.add('days-date-object', 'daysUntil', [D('2026-10-17'), T], 30)
    c.add('days-timestamp-prefix', 'daysUntil', ['2026-09-18T23:59:59Z', T], 1)
    c.add('days-null', 'daysUntil', [None, T], None)
    c.add('days-empty', 'daysUntil', ['', T], None)
    c.add('days-garbage', 'daysUntil', ['soon', T], None)
    c.add('days-invalid-date-object', 'daysUntil', [D(None), T], None)
    c.add('days-feb-30', 'daysUntil', ['2026-02-30', T], None, defect='CAL-1')

    # toDateOnlyString
    c.add('ymd-string', 'toDateOnlyString', ['2026-09-17'], '2026-09-17')
    c.add('ymd-date-object', 'toDateOnlyString', [D('2026-03-08')], '2026-03-08')
    c.add('ymd-timestamp', 'toDateOnlyString', ['2026-11-01T10:00:00Z'], '2026-11-01')
    c.add('ymd-null', 'toDateOnlyString', [None], None)
    c.add('ymd-garbage', 'toDateOnlyString', ['nonsense'], None)
    c.add('ymd-feb-30', 'toDateOnlyString', ['2026-02-30'], None, defect='CAL-1')
    # A two-digit-year date (what a browser date input holds mid-typing) is
    # year 26, not 1926 (CAL-2).
    c.add('ymd-year-0026', 'toDateOnlyString', ['0026-09-17'], '0026-09-17', defect='CAL-2')
    c.add('ymd-year-0099', 'toDateOnlyString', ['0099-12-31'], '0099-12-31', defect='CAL-2')
    c.add('ymd-year-0100', 'toDateOnlyString', ['0100-01-01'], '0100-01-01', defect='CAL-2')
    return c


if __name__ == '__main__':
    build().write('calendar_cases.json')
