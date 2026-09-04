#!/usr/bin/env python3
"""Independent oracle for the production back-allocation engine
(engines/production/allocation.js). Emits committed goldens to
test-data/production/goldens/allocation_cases.json.

INDEPENDENCE DISCIPLINE. This file is written from the METHOD the JS
engine documents -- the metered facility total split across the wells in
proportion to what each was capable of producing, a well's capability
being its latest valid test scaled by the hours it was on -- and NOT by
transcribing the JS. Where the two must agree they reach the number by
different roads:

  the split          the engine forms one FACTOR per phase per day
                     (measured / sum theoretical) and multiplies every
                     well's theoretical by it. The oracle never forms a
                     factor at all: it takes each well's SHARE of the
                     total directly, measured * theo_i / sum theo, which
                     is the sentence the method is stated in. The two
                     are algebraically the same and are different
                     floating-point computations; where they differ by
                     more than rounding, the split is not a split.

  closure            checked as a first-class output rather than
                     assumed. Sum of the allocated volumes minus the
                     metered total is emitted for every day and every
                     phase, and it must be zero to the last bit, because
                     an allocation that does not close is not an
                     allocation.

  test in force      the engine scans a well's test list forward and
                     breaks when it passes the date. The oracle builds
                     each test's explicit VALIDITY INTERVAL -- from its
                     own date until the next test's date, capped at
                     maxTestAgeDays -- and BISECTS into the interval
                     list. Different data structure, different search,
                     and it makes the age cap a property of the interval
                     rather than a post-check.

  monthly factors    the engine divides a month's allocated volume by
                     the same month's theoretical volume. The oracle
                     forms the THEORETICAL-VOLUME-WEIGHTED MEAN of that
                     month's DAILY factors, which is what "volume
                     weighted" actually claims. The two coincide only if
                     the daily factors really are being weighted by
                     theoretical volume, so this is the computation that
                     tests the docstring rather than repeating it.

  dates              the engine works in epoch-millisecond day numbers.
                     The oracle uses datetime.date and its timedelta
                     arithmetic throughout.

  the nodal cross    the engine takes the node solver as an injected
                     function. The oracle uses an ANALYTIC INSTRUMENT --
                     a straight-line inflow against a quadratic outflow,
                     whose crossing is a quadratic root written down in
                     closed form -- where the JS gate hands the same
                     instrument to the engine as a stub that finds the
                     crossing by BISECTION. Closed form against
                     bisection, and the classification derived from the
                     stated tolerance rule on both sides.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_allocation.py
"""
import json
import math
import os
from bisect import bisect_right
from datetime import date, timedelta
from statistics import median

PHASES = ('oil', 'water', 'gas')


def d(s):
    """ISO yyyy-mm-dd to a calendar date."""
    y, m, dd = (int(x) for x in s.split('-'))
    return date(y, m, dd)


def iso(dt):
    return dt.isoformat()


def daterange(start, end):
    """Inclusive list of ISO dates from start to end."""
    a, b = d(start), d(end)
    out = []
    while a <= b:
        out.append(iso(a))
        a += timedelta(days=1)
    return out


# ---------------------------------------------------------------------
# The field. Built from closed formulas so the dataset is reproducible
# and every number in it can be traced back to a rule a reader can see.
# ---------------------------------------------------------------------

WELLS = [
    {'id': 'w-p1', 'name': 'P-1', 'well_type': 'producer'},
    {'id': 'w-p2', 'name': 'P-2', 'well_type': 'producer'},
    {'id': 'w-p3', 'name': 'P-3', 'well_type': 'producer'},
    {'id': 'w-i1', 'name': 'I-1', 'well_type': 'injector'},
    {'id': 'w-o1', 'name': 'O-1', 'well_type': 'observation'},
]

# Well tests. P-1 is retested mid-series so the test in force changes
# under the allocation; P-2 carries one ageing test, which the 120-day
# variant lets expire partway through; P-3 has no valid test at all and
# therefore takes no allocation and says so.
TESTS = [
    {'id': 't-p1-a', 'well_id': 'w-p1', 'test_date': '2024-12-20',
     'oil_rate_stbd': 1200.0, 'water_rate_stbd': 300.0, 'gas_rate_mscfd': 640.0,
     'duration_hours': 12.0, 'thp_psia': 320.0, 'is_valid': True},
    {'id': 't-p1-bad', 'well_id': 'w-p1', 'test_date': '2025-01-30',
     'oil_rate_stbd': 0.0, 'water_rate_stbd': 0.0, 'gas_rate_mscfd': 0.0,
     'duration_hours': 2.0, 'thp_psia': 300.0, 'is_valid': False},
    {'id': 't-p1-b', 'well_id': 'w-p1', 'test_date': '2025-02-05',
     'oil_rate_stbd': 980.0, 'water_rate_stbd': 520.0, 'gas_rate_mscfd': 610.0,
     'duration_hours': 24.0, 'thp_psia': 305.0, 'is_valid': True},
    {'id': 't-p2-a', 'well_id': 'w-p2', 'test_date': '2024-09-15',
     'oil_rate_stbd': 640.0, 'water_rate_stbd': 60.0, 'gas_rate_mscfd': 210.0,
     'duration_hours': 18.0, 'thp_psia': 280.0, 'is_valid': True},
    {'id': 't-p3-a', 'well_id': 'w-p3', 'test_date': '2025-01-28',
     'oil_rate_stbd': 0.0, 'water_rate_stbd': 0.0, 'gas_rate_mscfd': 0.0,
     'duration_hours': 3.0, 'thp_psia': 0.0, 'is_valid': False},
]

# A longer test history for the outlier rule, which needs at least three
# earlier positive tests before it will read a well's own median.
QC_TESTS = [
    {'id': 'q-1', 'well_id': 'w-q1', 'test_date': '2024-10-01',
     'oil_rate_stbd': 500.0, 'water_rate_stbd': 100.0, 'gas_rate_mscfd': 250.0,
     'duration_hours': 12.0, 'is_valid': True},
    {'id': 'q-2', 'well_id': 'w-q1', 'test_date': '2024-11-01',
     'oil_rate_stbd': 520.0, 'water_rate_stbd': 110.0, 'gas_rate_mscfd': 260.0,
     'duration_hours': 12.0, 'is_valid': True},
    {'id': 'q-3', 'well_id': 'w-q1', 'test_date': '2024-12-01',
     'oil_rate_stbd': 480.0, 'water_rate_stbd': 120.0, 'gas_rate_mscfd': 240.0,
     'duration_hours': 12.0, 'is_valid': True},
    # 3x the well's own median: an outlier at twice the trigger, so high.
    {'id': 'q-4', 'well_id': 'w-q1', 'test_date': '2025-01-05',
     'oil_rate_stbd': 1500.0, 'water_rate_stbd': 100.0, 'gas_rate_mscfd': 700.0,
     'duration_hours': 12.0, 'is_valid': True},
    # 30 per cent off the median: inside the 50 per cent trigger, clean.
    {'id': 'q-5', 'well_id': 'w-q1', 'test_date': '2025-01-12',
     'oil_rate_stbd': 650.0, 'water_rate_stbd': 130.0, 'gas_rate_mscfd': 320.0,
     'duration_hours': 12.0, 'is_valid': True},
    # A short test on a date with no ledger row at all.
    {'id': 'q-6', 'well_id': 'w-q1', 'test_date': '2025-01-20',
     'oil_rate_stbd': 505.0, 'water_rate_stbd': 105.0, 'gas_rate_mscfd': 250.0,
     'duration_hours': 2.5, 'is_valid': True},
    # A separator that recorded nothing at all: the highest severity
    # there is, because a zero-rate test used for allocation removes the
    # well from the split entirely.
    {'id': 'q-7', 'well_id': 'w-q1', 'test_date': '2025-01-26',
     'oil_rate_stbd': 0.0, 'water_rate_stbd': 0.0, 'gas_rate_mscfd': 0.0,
     'duration_hours': 12.0, 'is_valid': True},
]

QC_WELL = {'id': 'w-q1', 'name': 'Q-1', 'well_type': 'producer'}

START, END = '2025-01-25', '2025-02-17'
DATES = daterange(START, END)


def hours_for(well_id, i):
    """Hours on stream, by a rule rather than by hand.

    P-1 runs full time except for a two-day outage; P-2 runs at 20 h on
    every third day; P-3 never reports hours at all (None), which is the
    'uptime unknown' case; the injector runs full time.
    """
    if well_id == 'w-p1':
        if i in (9, 10):
            return 0.0
        return 24.0
    if well_id == 'w-p2':
        return 20.0 if i % 3 == 0 else 24.0
    if well_id == 'w-p3':
        return None
    return 24.0


def ledger_rows():
    """The wells' own meters. Deliberately NOT equal to the facility
    total, because the gap between them is what an allocation engineer
    is looking at."""
    rows = []
    for i, dt in enumerate(DATES):
        h1 = hours_for('w-p1', i)
        rows.append({'well_id': 'w-p1', 'prod_date': dt, 'hours_on': h1,
                     'oil_stb': round(1150.0 * (h1 / 24.0), 6),
                     'water_stb': round((300.0 + 6.0 * i) * (h1 / 24.0), 6),
                     'gas_mscf': round(600.0 * (h1 / 24.0), 6),
                     'winj_stb': 0.0, 'ginj_mscf': 0.0})
        h2 = hours_for('w-p2', i)
        rows.append({'well_id': 'w-p2', 'prod_date': dt, 'hours_on': h2,
                     'oil_stb': round(600.0 * (h2 / 24.0), 6),
                     'water_stb': round(70.0 * (h2 / 24.0), 6),
                     'gas_mscf': round(200.0 * (h2 / 24.0), 6),
                     'winj_stb': 0.0, 'ginj_mscf': 0.0})
        rows.append({'well_id': 'w-p3', 'prod_date': dt, 'hours_on': None,
                     'oil_stb': 45.0, 'water_stb': 210.0, 'gas_mscf': 30.0,
                     'winj_stb': 0.0, 'ginj_mscf': 0.0})
        rows.append({'well_id': 'w-i1', 'prod_date': dt, 'hours_on': 24.0,
                     'oil_stb': 0.0, 'water_stb': 0.0, 'gas_mscf': 0.0,
                     'winj_stb': 3000.0, 'ginj_mscf': 0.0})
    return rows


def total_rows():
    """The facility meter. The oil total runs a few per cent under what
    the tests imply, which is the ordinary condition of a real field and
    is what makes the factor interesting."""
    rows = []
    for i, dt in enumerate(DATES):
        rows.append({
            'total_date': dt,
            'oil_stb': round(1700.0 - 4.0 * i, 6),
            'water_stb': round(380.0 + 9.0 * i, 6),
            'gas_mscf': round(880.0 - 2.0 * i, 6),
        })
    return rows


LEDGER = ledger_rows()
TOTALS = total_rows()
FIELD = {'wells': WELLS, 'tests': TESTS, 'ledger': LEDGER, 'totals': TOTALS}

# A deliberately impossible day, kept apart from the main field so it
# does not contaminate it. Both producers are shut for the whole of
# 2025-03-02 -- so the wells' capability is zero -- yet the facility
# meter recorded oil. There is nothing to allocate it in proportion TO,
# so nothing is allocated and the day is reported as having no basis.
# An allocator that quietly spread it anyway would be inventing a
# well's production out of a meter reading.
NO_BASIS_FIELD = {
    'wells': [
        {'id': 'n-p1', 'name': 'N-1', 'well_type': 'producer'},
        {'id': 'n-p2', 'name': 'N-2', 'well_type': 'producer'},
    ],
    'tests': [
        {'id': 'nt-1', 'well_id': 'n-p1', 'test_date': '2025-03-01',
         'oil_rate_stbd': 400.0, 'water_rate_stbd': 100.0, 'gas_rate_mscfd': 180.0,
         'duration_hours': 12.0, 'is_valid': True},
        {'id': 'nt-2', 'well_id': 'n-p2', 'test_date': '2025-03-01',
         'oil_rate_stbd': 300.0, 'water_rate_stbd': 50.0, 'gas_rate_mscfd': 120.0,
         'duration_hours': 12.0, 'is_valid': True},
    ],
    'ledger': [
        {'well_id': 'n-p1', 'prod_date': '2025-03-01', 'hours_on': 24.0,
         'oil_stb': 400.0, 'water_stb': 100.0, 'gas_mscf': 180.0,
         'winj_stb': 0.0, 'ginj_mscf': 0.0},
        {'well_id': 'n-p2', 'prod_date': '2025-03-01', 'hours_on': 12.0,
         'oil_stb': 150.0, 'water_stb': 25.0, 'gas_mscf': 60.0,
         'winj_stb': 0.0, 'ginj_mscf': 0.0},
        {'well_id': 'n-p1', 'prod_date': '2025-03-02', 'hours_on': 0.0,
         'oil_stb': 0.0, 'water_stb': 0.0, 'gas_mscf': 0.0,
         'winj_stb': 0.0, 'ginj_mscf': 0.0},
        {'well_id': 'n-p2', 'prod_date': '2025-03-02', 'hours_on': 0.0,
         'oil_stb': 0.0, 'water_stb': 0.0, 'gas_mscf': 0.0,
         'winj_stb': 0.0, 'ginj_mscf': 0.0},
    ],
    'totals': [
        {'total_date': '2025-03-01', 'oil_stb': 520.0, 'water_stb': 120.0, 'gas_mscf': 235.0},
        {'total_date': '2025-03-02', 'oil_stb': 310.0, 'water_stb': 60.0, 'gas_mscf': 140.0},
    ],
}

QC_LEDGER = [
    {'well_id': 'w-q1', 'prod_date': '2024-10-01', 'hours_on': 24.0,
     'oil_stb': 500.0, 'water_stb': 100.0, 'gas_mscf': 250.0},
    {'well_id': 'w-q1', 'prod_date': '2024-11-01', 'hours_on': 24.0,
     'oil_stb': 515.0, 'water_stb': 110.0, 'gas_mscf': 260.0},
    {'well_id': 'w-q1', 'prod_date': '2024-12-01', 'hours_on': 12.0,
     'oil_stb': 240.0, 'water_stb': 60.0, 'gas_mscf': 120.0},
    {'well_id': 'w-q1', 'prod_date': '2025-01-05', 'hours_on': 24.0,
     'oil_stb': 520.0, 'water_stb': 105.0, 'gas_mscf': 260.0},
    # A day whose ledger watercut is far from the test's: 40 per cent
    # against the test's 16 -- a 24 point gap on a 10 point trigger.
    {'well_id': 'w-q1', 'prod_date': '2025-01-12', 'hours_on': 24.0,
     'oil_stb': 640.0, 'water_stb': 427.0, 'gas_mscf': 320.0},
]


# ---------------------------------------------------------------------
# Test selection by explicit validity intervals
# ---------------------------------------------------------------------

def validity_intervals(tests, well_id, max_age_days, include_invalid=False):
    """Every test's [from, to) interval of authority over a well.

    A test carries the well from its own date until the next test's
    date, or until it is max_age_days old, whichever comes first. Gaps
    between intervals are dates on which the well has NO test in force,
    and a gap is a real answer rather than an omission.
    """
    ts = [t for t in tests
          if t['well_id'] == well_id and (include_invalid or t.get('is_valid') is not False)]
    ts.sort(key=lambda t: t['test_date'])
    out = []
    for i, t in enumerate(ts):
        start = d(t['test_date'])
        expiry = start + timedelta(days=max_age_days) if max_age_days and max_age_days > 0 else date.max
        nxt = d(ts[i + 1]['test_date']) - timedelta(days=1) if i + 1 < len(ts) else date.max
        end = min(expiry, nxt)
        if end >= start:
            out.append((start, end, t))
    return out


def test_in_force(intervals, on_date):
    """Bisect into the interval list. No scan, no break."""
    dt = d(on_date)
    starts = [iv[0] for iv in intervals]
    i = bisect_right(starts, dt) - 1
    if i < 0:
        return None
    start, end, t = intervals[i]
    return t if start <= dt <= end else None


# ---------------------------------------------------------------------
# The allocation, as shares of the total
# ---------------------------------------------------------------------

DEFAULT_SETTINGS = {
    'basis': 'test', 'maxTestAgeDays': 180, 'useUptime': True,
    'defaultHours': 24, 'includeInvalidTests': False,
    'factorWarnLow': 0.7, 'factorWarnHigh': 1.3,
}

RATE_KEY = {'oil': 'oil_rate_stbd', 'water': 'water_rate_stbd', 'gas': 'gas_rate_mscfd'}
VOL_KEY = {'oil': 'oil_stb', 'water': 'water_stb', 'gas': 'gas_mscf'}


def allocate(field, settings=None):
    s = dict(DEFAULT_SETTINGS)
    s.update(settings or {})
    wells, tests = field['wells'], field['tests']
    ledger, totals = field['ledger'], field['totals']
    producers = [w for w in wells if w['well_type'] not in ('injector', 'observation')]
    intervals = {w['id']: validity_intervals(
        tests, w['id'], s['maxTestAgeDays'], s['includeInvalidTests']) for w in producers}
    ledger_by = {}
    for r in ledger:
        ledger_by.setdefault(r['well_id'], {})[r['prod_date']] = r

    days = []
    per_well = {}
    grand = {'days': 0}
    for k in PHASES:
        grand['measured_' + k] = 0.0
        grand['theoretical_' + k] = 0.0
        grand['allocated_' + k] = 0.0
    diag = {}

    for total in sorted(totals, key=lambda t: t['total_date']):
        dt = total['total_date']
        measured = {k: total[VOL_KEY[k]] for k in PHASES}
        entries = []
        for w in producers:
            row = ledger_by.get(w['id'], {}).get(dt)
            hours = row['hours_on'] if row and row['hours_on'] is not None else s['defaultHours']
            uptime = (max(0.0, min(24.0, hours)) / 24.0) if s['useUptime'] else 1.0
            if s['basis'] == 'ledger':
                if row is None:
                    continue
                theo = {k: row[VOL_KEY[k]] for k in PHASES}
                entries.append({'wellId': w['id'], 'wellName': w['name'],
                                'uptime': uptime, 'testId': None, 'theoretical': theo})
                continue
            t = test_in_force(intervals[w['id']], dt)
            if t is None:
                diag['no_test_in_force'] = diag.get('no_test_in_force', 0) + 1
                continue
            theo = {k: t[RATE_KEY[k]] * uptime for k in PHASES}
            entries.append({'wellId': w['id'], 'wellName': w['name'],
                            'uptime': uptime, 'testId': t['id'], 'theoretical': theo})

        theoretical = {k: math.fsum(e['theoretical'][k] for e in entries) for k in PHASES}
        factors = {}
        for k in PHASES:
            if theoretical[k] > 0:
                factors[k] = measured[k] / theoretical[k]
                if factors[k] < s['factorWarnLow'] or factors[k] > s['factorWarnHigh']:
                    diag['factor_out_of_band'] = diag.get('factor_out_of_band', 0) + 1
            else:
                factors[k] = None
                if measured[k] > 0:
                    diag['no_basis'] = diag.get('no_basis', 0) + 1

        # THE SHARE FORM. No factor is used here.
        for e in entries:
            e['allocated'] = {}
            for k in PHASES:
                if theoretical[k] > 0:
                    e['allocated'][k] = measured[k] * e['theoretical'][k] / theoretical[k]
                else:
                    e['allocated'][k] = 0.0
        allocated = {k: math.fsum(e['allocated'][k] for e in entries) for k in PHASES}
        closure = {k: (allocated[k] - measured[k]) if theoretical[k] > 0 else 0.0
                   for k in PHASES}

        for e in entries:
            agg = per_well.setdefault(e['wellId'], {
                'wellId': e['wellId'], 'wellName': e['wellName'], 'days': 0,
                'theoretical': {k: 0.0 for k in PHASES},
                'allocated': {k: 0.0 for k in PHASES}})
            agg['days'] += 1
            for k in PHASES:
                agg['theoretical'][k] += e['theoretical'][k]
                agg['allocated'][k] += e['allocated'][k]

        days.append({'date': dt, 'measured': measured, 'theoretical': theoretical,
                     'factors': factors, 'allocated': allocated, 'closure': closure,
                     'entries': entries})
        grand['days'] += 1
        for k in PHASES:
            grand['measured_' + k] += measured[k]
            grand['theoretical_' + k] += theoretical[k]
            grand['allocated_' + k] += allocated[k]

    wells = sorted(per_well.values(),
                   key=lambda r: (-r['allocated']['oil'], r['wellName']))
    return {'settings': s, 'days': days, 'wells': wells, 'grand': grand,
            'diagnosticCounts': diag}


def monthly_factors_weighted(alloc):
    """The theoretical-volume-weighted mean of the DAILY factors.

    factor(month) = sum_days theo_day * factor_day / sum_days theo_day.

    This is what "volume weighted" means. It equals the ratio of the
    month's totals only because factor_day = allocated_day/theo_day, so
    computing it this way tests the claim instead of restating it.
    """
    agg = {}
    for day in alloc['days']:
        month = day['date'][:7] + '-01'
        for e in day['entries']:
            key = (e['wellId'], month)
            row = agg.setdefault(key, {
                'wellId': e['wellId'], 'wellName': e['wellName'],
                'periodMonth': month,
                'wsum': {k: 0.0 for k in PHASES},
                'w': {k: 0.0 for k in PHASES},
                'theoretical': {k: 0.0 for k in PHASES},
                'allocated': {k: 0.0 for k in PHASES}})
            for k in PHASES:
                theo = e['theoretical'][k]
                row['theoretical'][k] += theo
                row['allocated'][k] += e['allocated'][k]
                if theo > 0 and day['factors'][k] is not None:
                    row['wsum'][k] += theo * day['factors'][k]
                    row['w'][k] += theo
    out = []
    for row in agg.values():
        out.append({
            'wellId': row['wellId'], 'wellName': row['wellName'],
            'periodMonth': row['periodMonth'],
            'theoretical': row['theoretical'], 'allocated': row['allocated'],
            'factors': {k: (row['wsum'][k] / row['w'][k]) if row['w'][k] > 0 else 1.0
                        for k in PHASES},
        })
    out.sort(key=lambda r: (r['periodMonth'], r['wellName']))
    return out


def imbalance(alloc, ledger):
    booked = {}
    for r in ledger:
        b = booked.setdefault(r['prod_date'], {k: 0.0 for k in PHASES})
        for k in PHASES:
            b[k] += r[VOL_KEY[k]]
    out = []
    for day in alloc['days']:
        b = booked.get(day['date'], {k: 0.0 for k in PHASES})
        row = {'date': day['date']}
        for k in PHASES:
            row[k] = {
                'measured': day['measured'][k], 'booked': b[k],
                'imbalance': day['measured'][k] - b[k],
                'imbalancePct': ((day['measured'][k] - b[k]) / b[k] * 100.0) if b[k] > 0 else None,
            }
        out.append(row)
    return out


# ---------------------------------------------------------------------
# Well test QC
# ---------------------------------------------------------------------

QC_DEFAULTS = {'minDurationHours': 4, 'outlierPct': 50,
               'ledgerTolerancePct': 30, 'watercutTolerancePts': 10}
SEVERITY_RANK = {'high': 0, 'medium': 1, 'info': 2}


def derive_point(row):
    """The producing-day view of a ledger row, as ./surveillance.js
    defines it: volume scaled to 24 hours, null when shut in, and the
    calendar volume when the hours were never recorded."""
    oil, water, gas = row['oil_stb'], row['water_stb'], row['gas_mscf']
    h = row['hours_on']
    if h is None:
        pd = lambda v: v  # noqa: E731
    elif h <= 0:
        pd = lambda v: None  # noqa: E731
    else:
        pd = lambda v: v * 24.0 / h  # noqa: E731
    liquid = oil + water
    return {'date': row['prod_date'], 'oil': oil, 'water': water, 'gas': gas,
            'oilPd': pd(oil),
            'watercut': (water / liquid) if liquid > 0 else None}


def validate_tests(tests, ledger, settings=None):
    s = dict(QC_DEFAULTS)
    s.update(settings or {})
    points = {}
    for r in ledger:
        points.setdefault(r['well_id'], {})[r['prod_date']] = derive_point(r)

    by_well = {}
    for t in tests:
        by_well.setdefault(t['well_id'], []).append(t)
    for lst in by_well.values():
        lst.sort(key=lambda t: t['test_date'])

    results = []
    for well_id, lst in by_well.items():
        for i, t in enumerate(lst):
            issues = []
            oil = t.get('oil_rate_stbd') or 0.0
            water = t.get('water_rate_stbd') or 0.0
            gas = t.get('gas_rate_mscfd') or 0.0

            if oil + water + gas <= 0:
                issues.append(('zero_rate', 'high'))
            dur = t.get('duration_hours')
            if dur is not None and dur < s['minDurationHours']:
                issues.append(('short_duration', 'medium'))

            prior = [p.get('oil_rate_stbd') or 0.0 for p in lst[:i]]
            prior = [v for v in prior if v > 0]
            if len(prior) >= 3 and oil > 0:
                base = median(prior)
                dev = abs((oil - base) / base) * 100.0
                if dev >= s['outlierPct']:
                    issues.append(('rate_outlier',
                                   'high' if dev >= s['outlierPct'] * 2 else 'medium'))

            pt = points.get(well_id, {}).get(t['test_date'])
            if pt is None:
                issues.append(('no_ledger', 'info'))
            else:
                ledger_oil = pt['oilPd'] if pt['oilPd'] is not None else pt['oil']
                if oil > 0 and ledger_oil is not None and ledger_oil > 0:
                    dev = abs((oil - ledger_oil) / ledger_oil) * 100.0
                    if dev >= s['ledgerTolerancePct']:
                        issues.append(('ledger_mismatch',
                                       'high' if dev >= s['ledgerTolerancePct'] * 2 else 'medium'))
                test_wc = (water / (oil + water)) if (oil + water) > 0 else None
                if test_wc is not None and pt['watercut'] is not None:
                    pts = abs(test_wc - pt['watercut']) * 100.0
                    if pts >= s['watercutTolerancePts']:
                        issues.append(('watercut_mismatch', 'medium'))

            if not issues:
                continue
            worst = min(issues, key=lambda x: SEVERITY_RANK[x[1]])[1]
            results.append({'testId': t['id'], 'wellId': well_id,
                            'testDate': t['test_date'], 'severity': worst,
                            'codes': [c for c, _ in issues]})

    # Worst first, and within a severity the most recent test first.
    # Two stable passes rather than one composite key, because a
    # descending string is not a key a comparator can carry.
    results.sort(key=lambda r: r['testDate'], reverse=True)
    results.sort(key=lambda r: SEVERITY_RANK[r['severity']])
    return results


# ---------------------------------------------------------------------
# The nodal cross-check, on an analytic instrument
# ---------------------------------------------------------------------
#
# Inflow:   pwf = pr - q / J          (a straight line, PI form)
# Outflow:  pwf = whp + A + B q^2     (a lift head plus a friction term)
#
# Crossing: B q^2 + q / J + (whp + A - pr) = 0, so
#           q = (-1/J + sqrt(1/J^2 - 4 B (whp + A - pr))) / (2 B)
# and the well is dead when pr <= whp + A, because then no positive root
# exists. Written down; not searched for.

INSTRUMENT = {'pr': 2600.0, 'J': 1.8, 'A': 950.0, 'B': 0.00035}
NODAL_SETTINGS = {'tolerancePct': 35, 'minRateStbd': 1}


def instrument_crossing(thp):
    p = INSTRUMENT
    c = thp + p['A'] - p['pr']
    if c >= 0:
        return None
    disc = 1.0 / (p['J'] ** 2) - 4.0 * p['B'] * c
    return (-1.0 / p['J'] + math.sqrt(disc)) / (2.0 * p['B'])


NODAL_TESTS = [
    # Agrees with the model: a clean test.
    {'id': 'n-ok', 'well_id': 'w-n1', 'test_date': '2025-01-04',
     'oil_rate_stbd': 1180.0, 'water_rate_stbd': 200.0, 'gas_rate_mscfd': 500.0,
     'thp_psia': 320.0},
    # Half what the model says at the same wellhead pressure.
    {'id': 'n-low', 'well_id': 'w-n1', 'test_date': '2025-01-11',
     'oil_rate_stbd': 600.0, 'water_rate_stbd': 200.0, 'gas_rate_mscfd': 300.0,
     'thp_psia': 320.0},
    # Well above it.
    {'id': 'n-high', 'well_id': 'w-n1', 'test_date': '2025-01-18',
     'oil_rate_stbd': 1900.0, 'water_rate_stbd': 200.0, 'gas_rate_mscfd': 800.0,
     'thp_psia': 320.0},
    # A wellhead pressure the model cannot flow against, yet a rate was
    # recorded. One of the two is wrong and the check says so.
    {'id': 'n-dead', 'well_id': 'w-n1', 'test_date': '2025-01-25',
     'oil_rate_stbd': 700.0, 'water_rate_stbd': 100.0, 'gas_rate_mscfd': 300.0,
     'thp_psia': 1800.0},
    # No wellhead pressure recorded: nothing to solve at.
    {'id': 'n-nothp', 'well_id': 'w-n1', 'test_date': '2025-02-01',
     'oil_rate_stbd': 1100.0, 'water_rate_stbd': 150.0, 'gas_rate_mscfd': 450.0,
     'thp_psia': None},
    # A well with no model saved at all.
    {'id': 'n-nomodel', 'well_id': 'w-n2', 'test_date': '2025-02-01',
     'oil_rate_stbd': 800.0, 'water_rate_stbd': 100.0, 'gas_rate_mscfd': 300.0,
     'thp_psia': 300.0},
]

STATUS_RANK = {'dead': 0, 'off': 1, 'no-thp': 2, 'no-model': 3, 'ok': 4}


def nodal_cross_check():
    out = []
    for t in NODAL_TESTS:
        oil = t['oil_rate_stbd'] or 0.0
        base = {'testId': t['id'], 'wellId': t['well_id'], 'measuredStbd': oil}
        if t['well_id'] != 'w-n1':
            out.append(dict(base, nodalStbd=None, deviationPct=None, status='no-model'))
            continue
        thp = t['thp_psia']
        if thp is None or thp <= 0:
            out.append(dict(base, nodalStbd=None, deviationPct=None, status='no-thp'))
            continue
        q = instrument_crossing(thp)
        if q is None:
            out.append(dict(base, nodalStbd=None, deviationPct=None, status='dead'))
            continue
        if not (oil > NODAL_SETTINGS['minRateStbd']) or not (q > NODAL_SETTINGS['minRateStbd']):
            out.append(dict(base, nodalStbd=q, deviationPct=None, status='ok'))
            continue
        dev = (oil - q) / q * 100.0
        status = 'off' if abs(dev) >= NODAL_SETTINGS['tolerancePct'] else 'ok'
        out.append(dict(base, nodalStbd=q, deviationPct=dev, status=status))
    out.sort(key=lambda r: (STATUS_RANK[r['status']], -abs(r['deviationPct'] or 0.0)))
    return out


# ---------------------------------------------------------------------

def summarise(alloc):
    """A settings variant without the per-well entry lists: the day
    totals, the factors and the roll-ups, which is what a variant is
    being shown for. The base case carries the full detail."""
    return {
        'settings': alloc['settings'],
        'days': [{k: v for k, v in day.items() if k != 'entries'}
                 for day in alloc['days']],
        'wells': alloc['wells'],
        'grand': alloc['grand'],
        'diagnosticCounts': alloc['diagnosticCounts'],
    }


def emit():
    base = allocate(FIELD)
    ledger_basis = allocate(FIELD, {'basis': 'ledger'})
    aged = allocate(FIELD, {'maxTestAgeDays': 120})
    no_uptime = allocate(FIELD, {'useUptime': False})
    with_invalid = allocate(FIELD, {'includeInvalidTests': True})
    no_basis = allocate(NO_BASIS_FIELD)

    in_force = []
    for well in ('w-p1', 'w-p2', 'w-p3'):
        for max_age in (180, 120):
            ivs = validity_intervals(TESTS, well, max_age)
            for dt in ('2024-12-19', '2024-12-20', '2025-01-25', '2025-02-04',
                       '2025-02-05', '2025-02-17'):
                t = test_in_force(ivs, dt)
                in_force.append({'wellId': well, 'date': dt,
                                 'maxTestAgeDays': max_age,
                                 'testId': t['id'] if t else None})

    out = {
        'description': (
            'Production back-allocation goldens: the metered facility total split '
            'across the wells in proportion to what each was capable of producing '
            '(its latest valid well test scaled by the hours it was on), the '
            'volume-weighted monthly factors that fall out of it, the imbalance '
            'against the wells own meters, the well-test data QC, and the nodal '
            'cross-check of a test against its well model. Independent stdlib '
            'oracle (tools/validation/production/oracle_allocation.py) written '
            'from the method statement: every split taken as a SHARE of the total '
            '(measured * theoretical_i / sum theoretical) where the engine '
            'multiplies by a precomputed factor, every test in force found by '
            'BISECTING an explicit validity-interval list where the engine scans '
            'and breaks, every monthly factor formed as the THEORETICAL-WEIGHTED '
            'MEAN of the daily factors where the engine divides one month total '
            'by another, all date arithmetic done on the calendar where the engine '
            'uses epoch day numbers, and the nodal crossing written down as a '
            'QUADRATIC ROOT where the engine is handed a bisecting solver. '
            'Field units: stb for oil and water, Mscf for gas, stb/d and Mscf/d '
            'for test rates, hours 0-24, psia, dates ISO yyyy-mm-dd.'),
        'field': FIELD,
        'testInForce': in_force,
        'allocation': base,
        'allocationLedgerBasis': summarise(ledger_basis),
        'allocationAged120': summarise(aged),
        'allocationNoUptime': summarise(no_uptime),
        'allocationWithInvalidTests': summarise(with_invalid),
        'monthlyFactors': monthly_factors_weighted(base),
        'imbalance': imbalance(base, LEDGER),
        'noBasis': {'field': NO_BASIS_FIELD, 'allocation': no_basis},
        'testQc': {
            'well': QC_WELL,
            'tests': QC_TESTS,
            'ledger': QC_LEDGER,
            'results': validate_tests(QC_TESTS, QC_LEDGER),
        },
        'nodalCrossCheck': {
            'instrument': INSTRUMENT,
            'settings': NODAL_SETTINGS,
            'tests': NODAL_TESTS,
            'results': nodal_cross_check(),
        },
    }

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.abspath(os.path.join(
        here, '..', '..', '..', 'test-data', 'production', 'goldens',
        'allocation_cases.json'))
    with open(dest, 'w') as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', dest)


if __name__ == '__main__':
    emit()
