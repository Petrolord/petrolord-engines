#!/usr/bin/env python3
"""Independent oracle for the production surveillance engine
(engines/production/surveillance.js). Emits committed goldens to
test-data/production/goldens/surveillance_cases.json.

INDEPENDENCE DISCIPLINE. This file is written from the METHOD the JS
engine documents -- a recent window compared against a baseline window
on the same well, both anchored on the field's own latest ledger date,
widened when the ledger is coarse -- and NOT by transcribing the JS.
Where the two must agree they reach the number by different roads:

  dates             the engine converts every ISO date to an epoch
                    millisecond count and divides by 86400000. The
                    oracle uses datetime.date and timedelta throughout
                    and never forms a day number at all.

  window membership the engine implements the recent window as the
                    half-open inequality d > asOf - recentDays and
                    d <= asOf. The oracle takes the window from the
                    STATED definition instead -- "the recentDays days
                    ending at asOf, inclusive" -- as the closed calendar
                    interval [asOf - recentDays + 1, asOf], and builds
                    the baseline the same way. If the implemented
                    inequality is off by a day at either edge the two
                    memberships differ and the means diverge.

  effective decline the engine evaluates a closed form per Arps family.
                    The oracle does not use a closed form: it EVALUATES
                    THE RATE LAW at t = 0 and t = 365 and takes
                    1 - q(365)/q(0), which is the definition the closed
                    forms are derived from. A wrong exponent or a wrong
                    b-limit shows up immediately.

  the decline fit   not reimplemented at all, and deliberately. The
                    oracle SYNTHESISES a series from known (qi, Di, b),
                    so the truth is known by construction and the gate
                    is the fitter recovering the parameters that made
                    the data. An oracle that re-fit the same data with
                    the same method would only prove two least squares
                    agree.

  cadence           statistics.median over the calendar gaps.

THE RATIO SEAM, MEASURED. `computeKpis` forms a period watercut and GOR
VOLUMETRICALLY -- sum of water over sum of liquid -- which is what a
period ratio means. `detectExceptions` forms them as the MEAN OF THE
DAILY RATIOS, a different quantity that is pulled upward by low-rate
days. This oracle computes BOTH for the same windows and emits the gap,
because on the golden well the difference is large enough to change the
SEVERITY a shipped studio prints against a well. It is emitted as a
finding, not corrected: correcting it would move a displayed number.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_surveillance.py
"""
import json
import math
import os
from datetime import date, timedelta
from statistics import median

SETTINGS = {
    'recentDays': 7, 'baselineDays': 30, 'rateDropPct': 20,
    'watercutRisePts': 10, 'gorRisePct': 30, 'downtimeHours': 20,
    'staleDays': 7, 'minOilRate': 5,
}
SEVERITY_RANK = {'high': 0, 'medium': 1, 'info': 2}


def d(s):
    y, m, dd = (int(x) for x in s.split('-'))
    return date(y, m, dd)


def iso(dt):
    return dt.isoformat()


def shift(s, n):
    return iso(d(s) + timedelta(days=n))


# ---------------------------------------------------------------------
# The field.
#
# Daily wells run 2025-05-15 to 2025-06-30 (47 rows, index 0..46), so
# index 46 is the field's latest date. The recent window is then indices
# 40..46 and the baseline 10..39, which is what every daily well below
# is built around.
# ---------------------------------------------------------------------

DAY0 = '2025-05-15'
NDAYS = 47
AS_OF = shift(DAY0, NDAYS - 1)          # 2025-06-30

WELLS = {
    'w-p1': {'id': 'w-p1', 'name': 'P-1', 'well_type': 'producer'},
    'w-p2': {'id': 'w-p2', 'name': 'P-2', 'well_type': 'producer'},
    'w-p3': {'id': 'w-p3', 'name': 'P-3', 'well_type': 'producer'},
    'w-p4': {'id': 'w-p4', 'name': 'P-4', 'well_type': 'producer'},
    'w-p5': {'id': 'w-p5', 'name': 'P-5', 'well_type': 'producer'},
    'w-i1': {'id': 'w-i1', 'name': 'I-1', 'well_type': 'injector'},
    'w-o1': {'id': 'w-o1', 'name': 'O-1', 'well_type': 'observation'},
}


def row(well_id, dt, oil=0.0, water=0.0, gas=0.0, winj=0.0, ginj=0.0, hours=24.0):
    return {'well_id': well_id, 'prod_date': dt, 'oil_stb': oil, 'water_stb': water,
            'gas_mscf': gas, 'winj_stb': winj, 'ginj_mscf': ginj, 'hours_on': hours}


def build_ledger():
    rows = []
    for i in range(NDAYS):
        dt = shift(DAY0, i)
        recent = i >= 40

        # P-1: the interesting well. Rate falls, water cut climbs, gas
        # ratio climbs, and one day in the recent window is a near
        # shut-in that makes its own ratios enormous. That day is the
        # whole point: it is what separates a mean of daily ratios from
        # a volumetric ratio.
        if not recent:
            rows.append(row('w-p1', dt, oil=900.0, water=490.0, gas=720.0))
        elif i == 43:
            rows.append(row('w-p1', dt, oil=50.0, water=700.0, gas=140.0))
        else:
            rows.append(row('w-p1', dt, oil=640.0, water=640.0, gas=717.0))

        # P-2: producing, then stopped dead in the recent window.
        if not recent:
            rows.append(row('w-p2', dt, oil=400.0, water=100.0, gas=200.0))
        else:
            rows.append(row('w-p2', dt, oil=0.0, water=0.0, gas=0.0, hours=0.0))

        # P-5: still producing but only a third of the day, which is a
        # downtime exception AND a rate drop, and both should be said.
        if not recent:
            rows.append(row('w-p5', dt, oil=300.0, water=60.0, gas=150.0, hours=24.0))
        else:
            rows.append(row('w-p5', dt, oil=100.0, water=20.0, gas=50.0, hours=8.0))

        # P-4: stops reporting on 2025-06-10, twenty days before the
        # field's frontier.
        if i <= 26:
            rows.append(row('w-p4', dt, oil=500.0, water=120.0, gas=260.0))

        # I-1: an injector whose injection fell away.
        rows.append(row('w-i1', dt, winj=3000.0 if not recent else 1900.0))

        # O-1: an observation well. It carries rows and must be ignored.
        rows.append(row('w-o1', dt, hours=None))

    # P-3: a MONTHLY ledger on the same field, so the widening rule has
    # something to widen for. Volumes are monthly, which is what a
    # monthly ledger holds.
    for dt, oil in (('2025-01-31', 15000.0), ('2025-02-28', 15000.0),
                    ('2025-03-31', 15000.0), ('2025-04-30', 15000.0),
                    ('2025-05-31', 15000.0), ('2025-06-30', 9000.0)):
        rows.append(row('w-p3', dt, oil=oil, water=oil * 0.25, gas=oil * 0.6, hours=None))
    return rows


LEDGER = build_ledger()


# ---------------------------------------------------------------------
# Derived quantities
# ---------------------------------------------------------------------

def derive(r):
    oil, water, gas = r['oil_stb'], r['water_stb'], r['gas_mscf']
    h = r['hours_on']
    liquid = oil + water

    def pd(v):
        if h is None:
            return v
        if h <= 0:
            return None
        return v * 24.0 / h

    return {
        'date': r['prod_date'], 'oil': oil, 'water': water, 'gas': gas,
        'winj': r['winj_stb'], 'ginj': r['ginj_mscf'], 'hoursOn': h,
        'liquid': liquid,
        'watercut': (water / liquid) if liquid > 0 else None,
        'gor': (gas * 1000.0 / oil) if oil > 0 else None,
        'oilPd': pd(oil), 'waterPd': pd(water), 'gasPd': pd(gas),
        'liquidPd': pd(liquid), 'winjPd': pd(r['winj_stb']),
    }


def well_series(ledger):
    by = {}
    for r in ledger:
        by.setdefault(r['well_id'], []).append(derive(r))
    out = [{'well': WELLS[k], 'points': sorted(v, key=lambda p: p['date'])}
           for k, v in by.items()]
    out.sort(key=lambda s: s['well']['name'])
    return out


def field_series(ledger):
    by = {}
    for r in ledger:
        f = by.setdefault(r['prod_date'], {'date': r['prod_date'], 'oil': 0.0, 'water': 0.0,
                                           'gas': 0.0, 'winj': 0.0, 'ginj': 0.0, 'wellsOn': 0})
        f['oil'] += r['oil_stb']
        f['water'] += r['water_stb']
        f['gas'] += r['gas_mscf']
        f['winj'] += r['winj_stb']
        f['ginj'] += r['ginj_mscf']
        producing = (r['oil_stb'] + r['water_stb'] + r['gas_mscf']) > 0 \
            and (r['hours_on'] is None or r['hours_on'] > 0)
        if producing:
            f['wellsOn'] += 1
    out = []
    for f in by.values():
        liq = f['oil'] + f['water']
        f = dict(f, liquid=liq,
                 watercut=(f['water'] / liq) if liq > 0 else None,
                 gor=(f['gas'] * 1000.0 / f['oil']) if f['oil'] > 0 else None)
        out.append(f)
    out.sort(key=lambda f: f['date'])
    return out


def cadence_days(points):
    if len(points) < 2:
        return None
    gaps = [(d(points[i]['date']) - d(points[i - 1]['date'])).days
            for i in range(1, len(points))]
    return median(gaps)


def moving_average(points, key, window_days):
    """Trailing mean over the CLOSED calendar interval
    [date - windowDays + 1, date]."""
    out = []
    for p in points:
        if p[key] is None:
            out.append(None)
            continue
        hi = d(p['date'])
        lo = hi - timedelta(days=window_days - 1)
        vals = [q[key] for q in points
                if lo <= d(q['date']) <= hi and q[key] is not None]
        out.append((math.fsum(vals) / len(vals)) if vals else None)
    return out


def decimate(points, max_points=1500):
    if len(points) <= max_points:
        return list(points)
    stride = -(-len(points) // max_points)
    out = points[::stride]
    if out[-1] is not points[-1]:
        out = out + [points[-1]]
    return out


# ---------------------------------------------------------------------
# Exception surveillance
# ---------------------------------------------------------------------

def window_stats(points, key, lo, hi):
    """Mean and count over the CLOSED calendar interval [lo, hi]."""
    vals = [p[key] for p in points if lo <= d(p['date']) <= hi and p[key] is not None]
    return {'mean': (math.fsum(vals) / len(vals)) if vals else None, 'count': len(vals)}


def window_volumetric(points, num_key, den_keys, lo, hi):
    """The VOLUMETRIC ratio over the same window: sum of the numerator
    over the sum of the denominator. Since item 18 this is what BOTH
    halves compute; the seam block below keeps measuring the gap against
    the mean of the daily ratios, because that gap is the reason the
    change was made and it is worth keeping on the record."""
    num = math.fsum(p[num_key] for p in points if lo <= d(p['date']) <= hi)
    den = math.fsum(sum(p[k] for k in den_keys) for p in points
                    if lo <= d(p['date']) <= hi)
    return (num / den) if den > 0 else None


def detect_exceptions(series, settings=None):
    s = dict(SETTINGS)
    s.update(settings or {})
    live = [w for w in series if w['points'] and w['well']['well_type'] != 'observation']
    if not live:
        return {'asOf': None, 'exceptions': []}
    as_of = max(w['points'][-1]['date'] for w in live)
    as_of_d = d(as_of)

    out = []

    def push(well, kind, sev, value, baseline):
        out.append({'wellId': well['id'], 'wellName': well['name'], 'type': kind,
                    'severity': sev, 'value': value, 'baseline': baseline})

    for w in live:
        well, points = w['well'], w['points']
        injector = well['well_type'] == 'injector'
        cadence = cadence_days(points) or 1
        recent_days = max(s['recentDays'], math.ceil(cadence * 1.5))
        baseline_days = max(s['baselineDays'], math.ceil(cadence * 4))
        stale_days = max(s['staleDays'], math.ceil(cadence * 1.5))

        gap = (as_of_d - d(points[-1]['date'])).days
        if gap > stale_days:
            push(well, 'stale_data', 'medium' if gap > stale_days * 2 else 'info',
                 gap, stale_days)
            continue

        r_hi, r_lo = as_of_d, as_of_d - timedelta(days=recent_days - 1)
        b_hi = r_lo - timedelta(days=1)
        b_lo = b_hi - timedelta(days=baseline_days - 1)

        # Item 73. The calendar mean answers "did this well stop"; the
        # producing-day rate answers "did this well weaken". A well cut
        # back to twelve hours a day halves its calendar volume with its
        # rate unmoved, and the change test used to call that a fifty
        # percent decline.
        rate_key = 'winj' if injector else 'oil'
        pd_key = 'winjPd' if injector else 'oilPd'
        recent = window_stats(points, rate_key, r_lo, r_hi)
        base = window_stats(points, rate_key, b_lo, b_hi)
        recent_pd = window_stats(points, pd_key, r_lo, r_hi)
        base_pd = window_stats(points, pd_key, b_lo, b_hi)
        if base['count'] and recent['count'] and base['mean'] >= s['minOilRate']:
            if recent['mean'] <= 0:
                push(well, 'shut_in', 'high', 0, base['mean'])
            elif (base_pd['count'] and recent_pd['count']
                  and base_pd['mean'] >= s['minOilRate']):
                drop = (base_pd['mean'] - recent_pd['mean']) / base_pd['mean'] * 100.0
                if drop >= s['rateDropPct']:
                    push(well, 'injection_drop' if injector else 'rate_drop',
                         'high' if drop >= s['rateDropPct'] * 2 else 'medium',
                         recent_pd['mean'], base_pd['mean'])

        if not injector:
            # Item 18. Volumetric, total over total, the same way the
            # KPI half has always formed it. The mean of the daily ratios
            # is a different quantity, biased by low-rate days, and the
            # ratio seam block below measures by how much.
            wc_r = window_volumetric(points, 'water', ('oil', 'water'), r_lo, r_hi)
            wc_b = window_volumetric(points, 'water', ('oil', 'water'), b_lo, b_hi)
            wc_n_r = window_stats(points, 'watercut', r_lo, r_hi)['count']
            wc_n_b = window_stats(points, 'watercut', b_lo, b_hi)['count']
            if wc_n_r and wc_n_b and wc_r is not None and wc_b is not None:
                rise = (wc_r - wc_b) * 100.0
                if rise >= s['watercutRisePts']:
                    push(well, 'watercut_rise',
                         'high' if rise >= s['watercutRisePts'] * 2 else 'medium',
                         wc_r, wc_b)

            g_r = window_volumetric(points, 'gas', ('oil',), r_lo, r_hi)
            g_b = window_volumetric(points, 'gas', ('oil',), b_lo, b_hi)
            g_r = None if g_r is None else g_r * 1000.0
            g_b = None if g_b is None else g_b * 1000.0
            g_n_r = window_stats(points, 'gor', r_lo, r_hi)['count']
            g_n_b = window_stats(points, 'gor', b_lo, b_hi)['count']
            if g_n_r and g_n_b and g_b and g_b > 0 \
                    and (base['mean'] is None or base['mean'] >= s['minOilRate']):
                rise = (g_r - g_b) / g_b * 100.0
                if rise >= s['gorRisePct']:
                    push(well, 'gor_rise',
                         'high' if rise >= s['gorRisePct'] * 2 else 'medium',
                         g_r, g_b)

            # Item 79, first half. A well averaging exactly 0.00 hours on
            # stream was the one well the downtime check could never
            # report: the worst case it exists for was the case it
            # excluded.
            hrs = window_stats(points, 'hoursOn', r_lo, r_hi)
            if hrs['count'] and hrs['mean'] < s['downtimeHours']:
                push(well, 'downtime', 'medium', hrs['mean'], s['downtimeHours'])

    out.sort(key=lambda e: (SEVERITY_RANK[e['severity']], e['wellName']))
    return {'asOf': as_of, 'exceptions': out}


def ratio_seam(series):
    """The same two windows on P-1, read both ways, with the gap that
    falls out and what it does to the reported severity."""
    w = next(x for x in series if x['well']['id'] == 'w-p1')
    points = w['points']
    as_of_d = d(AS_OF)
    r_hi, r_lo = as_of_d, as_of_d - timedelta(days=SETTINGS['recentDays'] - 1)
    b_hi = r_lo - timedelta(days=1)
    b_lo = b_hi - timedelta(days=SETTINGS['baselineDays'] - 1)

    def both(num_key, den_keys, key):
        return {
            'recentMeanOfRatios': window_stats(points, key, r_lo, r_hi)['mean'],
            'recentVolumetric': window_volumetric(points, num_key, den_keys, r_lo, r_hi),
            'baselineMeanOfRatios': window_stats(points, key, b_lo, b_hi)['mean'],
            'baselineVolumetric': window_volumetric(points, num_key, den_keys, b_lo, b_hi),
        }

    wc = both('water', ('oil', 'water'), 'watercut')
    wc['riseByMeanOfRatiosPts'] = (wc['recentMeanOfRatios'] - wc['baselineMeanOfRatios']) * 100.0
    wc['riseByVolumetricPts'] = (wc['recentVolumetric'] - wc['baselineVolumetric']) * 100.0
    wc['severityByMeanOfRatios'] = 'high' if wc['riseByMeanOfRatiosPts'] >= 20 else 'medium'
    wc['severityByVolumetric'] = 'high' if wc['riseByVolumetricPts'] >= 20 else 'medium'

    # GOR in scf/stb: gas is Mscf, so the volumetric ratio carries the
    # same 1000 the per-row ratio does.
    gor_recent_vol = 1000.0 * math.fsum(p['gas'] for p in points if r_lo <= d(p['date']) <= r_hi) \
        / math.fsum(p['oil'] for p in points if r_lo <= d(p['date']) <= r_hi)
    gor_base_vol = 1000.0 * math.fsum(p['gas'] for p in points if b_lo <= d(p['date']) <= b_hi) \
        / math.fsum(p['oil'] for p in points if b_lo <= d(p['date']) <= b_hi)
    gor = {
        'recentMeanOfRatios': window_stats(points, 'gor', r_lo, r_hi)['mean'],
        'recentVolumetric': gor_recent_vol,
        'baselineMeanOfRatios': window_stats(points, 'gor', b_lo, b_hi)['mean'],
        'baselineVolumetric': gor_base_vol,
    }
    gor['riseByMeanOfRatiosPct'] = (gor['recentMeanOfRatios'] - gor['baselineMeanOfRatios']) \
        / gor['baselineMeanOfRatios'] * 100.0
    gor['riseByVolumetricPct'] = (gor['recentVolumetric'] - gor['baselineVolumetric']) \
        / gor['baselineVolumetric'] * 100.0
    gor['severityByMeanOfRatios'] = 'high' if gor['riseByMeanOfRatiosPct'] >= 60 else 'medium'
    gor['severityByVolumetric'] = 'high' if gor['riseByVolumetricPct'] >= 60 else 'medium'
    gor['overstatementPct'] = (gor['recentMeanOfRatios'] / gor['recentVolumetric'] - 1.0) * 100.0

    return {'well': 'P-1', 'window': {'recentFrom': iso(r_lo), 'recentTo': iso(r_hi),
                                      'baselineFrom': iso(b_lo), 'baselineTo': iso(b_hi)},
            'watercut': wc, 'gor': gor}


# ---------------------------------------------------------------------
# Deferments and KPIs
# ---------------------------------------------------------------------

DEFERMENTS = [
    {'category': 'Facility', 'start_date': '2025-06-01', 'end_date': '2025-06-04',
     'oil_deferred_stb': 3200.0, 'water_deferred_stb': 800.0, 'gas_deferred_mscf': 1900.0},
    {'category': 'Facility', 'start_date': '2025-06-20', 'end_date': '2025-06-21',
     'oil_deferred_stb': 1400.0, 'water_deferred_stb': 300.0, 'gas_deferred_mscf': 800.0},
    {'category': 'Well integrity', 'start_date': '2025-05-28', 'end_date': '2025-06-06',
     'oil_deferred_stb': 5100.0, 'water_deferred_stb': 1200.0, 'gas_deferred_mscf': 2600.0},
    {'category': 'Power', 'start_date': '2025-06-27', 'end_date': None,
     'oil_deferred_stb': 900.0, 'water_deferred_stb': 200.0, 'gas_deferred_mscf': 500.0},
    # An event that starts and ends on the same day is ONE day, not zero.
    {'category': 'Power', 'start_date': '2025-06-15', 'end_date': '2025-06-15',
     'oil_deferred_stb': 250.0, 'water_deferred_stb': 60.0, 'gas_deferred_mscf': 140.0},
]


def summarize_deferments(deferments, as_of):
    as_of_d = d(as_of)
    by = {}
    open_count = 0
    for ev in deferments:
        end = d(ev['end_date']) if ev['end_date'] else as_of_d
        days = max(1, (end - d(ev['start_date'])).days + 1)
        if not ev['end_date']:
            open_count += 1
        c = by.setdefault(ev['category'], {'category': ev['category'], 'events': 0,
                                           'days': 0, 'oil': 0.0, 'water': 0.0, 'gas': 0.0})
        c['events'] += 1
        c['days'] += days
        c['oil'] += ev['oil_deferred_stb']
        c['water'] += ev['water_deferred_stb']
        c['gas'] += ev['gas_deferred_mscf']
    cats = sorted(by.values(), key=lambda c: (-c['oil'], -c['days']))
    totals = {'events': sum(c['events'] for c in cats), 'days': sum(c['days'] for c in cats),
              'oil': math.fsum(c['oil'] for c in cats),
              'water': math.fsum(c['water'] for c in cats),
              'gas': math.fsum(c['gas'] for c in cats)}
    return {'byCategory': cats, 'totals': totals, 'openCount': open_count}


def compute_kpis(series, field, window_days=7):
    if not field:
        return None
    as_of = field[-1]['date']
    lo = d(as_of) - timedelta(days=window_days - 1)
    win = [f for f in field if d(f['date']) >= lo]
    hours_sum, slots = 0.0, 0
    for w in series:
        if w['well']['well_type'] == 'injector':
            continue
        for p in w['points']:
            if d(p['date']) >= lo and p['hoursOn'] is not None:
                hours_sum += p['hoursOn']
                slots += 1
    oil = math.fsum(f['oil'] for f in win) / len(win)
    water = math.fsum(f['water'] for f in win) / len(win)
    gas = math.fsum(f['gas'] for f in win) / len(win)
    return {
        'asOf': as_of, 'windowDays': window_days,
        'oil': oil, 'water': water, 'gas': gas,
        'winj': math.fsum(f['winj'] for f in win) / len(win),
        'liquid': oil + water,
        'watercut': (water / (oil + water)) if (oil + water) > 0 else None,
        'gor': (gas * 1000.0 / oil) if oil > 0 else None,
        'uptimePct': (hours_sum / (slots * 24.0) * 100.0) if slots else None,
        'wellCount': len(series),
        'producerCount': len([w for w in series if w['well']['well_type'] != 'injector']),
    }


# ---------------------------------------------------------------------
# Decline: the rate law evaluated, and a synthetic series whose
# parameters are known by construction
# ---------------------------------------------------------------------

def arps_rate(qi, di, b, t):
    """The Arps rate law. Exponential and harmonic are the b -> 0 and
    b = 1 limits, written as limits rather than as separate formulas."""
    if b == 0:
        return qi * math.exp(-di * t)
    if b == 1:
        return qi / (1.0 + di * t)
    return qi / (1.0 + b * di * t) ** (1.0 / b)


def effective_decline_pct(di, b):
    """1 - q(365)/q(0). The DEFINITION, not a closed form."""
    if di is None or di <= 0:
        return None
    return (1.0 - arps_rate(1.0, di, b, 365.0) / arps_rate(1.0, di, b, 0.0)) * 100.0


DECLINE_CASES = [
    {'Di': 0.0015, 'b': 0.0, 'modelType': 'Exponential'},
    {'Di': 0.0015, 'b': 1.0, 'modelType': 'Harmonic'},
    {'Di': 0.0015, 'b': 0.5, 'modelType': 'Hyperbolic'},
    {'Di': 0.003, 'b': 0.8, 'modelType': 'Hyperbolic'},
    {'Di': 0.0005, 'b': 0.0, 'modelType': 'Exponential'},
]

SYNTH = {'qi': 1200.0, 'Di': 0.0015, 'b': 0.0, 'nDays': 90, 'start': '2025-01-01'}


def synthetic_decline():
    """An EXACT exponential decline, 90 daily points. Nothing is fitted
    here: these are the parameters the data was made from, and the gate
    is the canonical fitter recovering them."""
    rows = []
    for i in range(SYNTH['nDays']):
        q = arps_rate(SYNTH['qi'], SYNTH['Di'], SYNTH['b'], float(i))
        rows.append({'well_id': 'w-dec', 'prod_date': shift(SYNTH['start'], i),
                     'oil_stb': q, 'water_stb': q * 0.2, 'gas_mscf': q * 0.5,
                     'winj_stb': 0.0, 'ginj_mscf': 0.0, 'hours_on': 24.0})
    return rows


# ---------------------------------------------------------------------

def emit():
    series = well_series(LEDGER)
    field = field_series(LEDGER)

    derive_cases = [
        # the ordinary day
        row('w-x', '2025-01-01', oil=800.0, water=200.0, gas=400.0, hours=24.0),
        # a half day: the producing-day rate is twice the volume
        row('w-x', '2025-01-02', oil=500.0, water=100.0, gas=250.0, hours=12.0),
        # SHUT IN: zero hours is a null producing-day rate, NEVER Infinity
        row('w-x', '2025-01-03', oil=0.0, water=0.0, gas=0.0, hours=0.0),
        # hours never recorded: uptime unknown, so the calendar volume stands
        row('w-x', '2025-01-04', oil=450.0, water=90.0, gas=225.0, hours=None),
        # no liquid at all: no water cut to report, and no gas-oil ratio
        row('w-x', '2025-01-05', oil=0.0, water=0.0, gas=120.0, hours=24.0),
    ]

    p1 = next(w for w in series if w['well']['id'] == 'w-p1')['points']
    dec_rows = synthetic_decline()
    dec_points = [derive(r) for r in dec_rows]

    out = {
        'description': (
            'Production surveillance goldens: producing-day derivation, per-well and '
            'field series, ledger cadence, trailing moving averages, exception '
            'surveillance against a baseline window, deferment roll-up, field KPIs '
            'and the effective decline of an Arps fit. Independent stdlib oracle '
            '(tools/validation/production/oracle_surveillance.py) written from the '
            'method statement: all date arithmetic on the calendar where the engine '
            'counts epoch days, every window taken as the CLOSED interval the method '
            'states rather than the inequality the engine implements, effective '
            'decline measured as 1 - q(365)/q(0) through the rate law where the '
            'engine evaluates a closed form, and the decline fit gated against a '
            'series SYNTHESISED from known parameters rather than against a second '
            'fitter. Also carries the RATIO SEAM: the same windows read as a mean of '
            'daily ratios (what detectExceptions does) and volumetrically (what '
            'computeKpis does), with the gap and the severity it changes. '
            'Field units: stb, Mscf, stb/d, Mscf/d, scf/stb, hours 0-24, watercut a '
            '0-1 fraction, Di per DAY, dates ISO yyyy-mm-dd.'),
        'wells': WELLS,
        'ledger': LEDGER,
        'derivePoint': {'rows': derive_cases, 'points': [derive(r) for r in derive_cases]},
        'wellSeries': [{'wellId': w['well']['id'], 'name': w['well']['name'],
                        'n': len(w['points']),
                        'cadenceDays': cadence_days(w['points'])} for w in series],
        'fieldSeries': field,
        'movingAverage': {
            'wellId': 'w-p1', 'key': 'oil', 'windowDays': 7,
            'values': moving_average(p1, 'oil', 7),
        },
        'movingAverageWatercut': {
            'wellId': 'w-p1', 'key': 'watercut', 'windowDays': 14,
            'values': moving_average(p1, 'watercut', 14),
        },
        'decimate': {
            'n': 3200, 'maxPoints': 1500,
            'stride': -(-3200 // 1500),
            'outLength': len(decimate(list(range(3200)), 1500)),
            'firstIndices': decimate(list(range(3200)), 1500)[:5],
            'lastIndex': decimate(list(range(3200)), 1500)[-1],
        },
        'exceptions': detect_exceptions(series),
        'exceptionsStrictDrop': detect_exceptions(series, {'rateDropPct': 40}),
        'ratioSeam': ratio_seam(series),
        'deferments': {'events': DEFERMENTS, 'asOf': AS_OF,
                       'summary': summarize_deferments(DEFERMENTS, AS_OF)},
        'kpis': compute_kpis(series, field, 7),
        'kpis30': compute_kpis(series, field, 30),
        'effectiveDecline': [
            dict(c, effectivePct=effective_decline_pct(c['Di'], c['b']))
            for c in DECLINE_CASES
        ],
        'syntheticDecline': {
            'truth': SYNTH,
            'rows': dec_rows,
            'firstRate': dec_points[0]['oilPd'],
            'lastRate': dec_points[-1]['oilPd'],
            'effectivePct': effective_decline_pct(SYNTH['Di'], SYNTH['b']),
        },
    }

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.abspath(os.path.join(
        here, '..', '..', '..', 'test-data', 'production', 'goldens',
        'surveillance_cases.json'))
    with open(dest, 'w') as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', dest)


if __name__ == '__main__':
    emit()
