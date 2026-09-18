#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/complianceStatus.js (AS12, group A).

Stdlib only. The rules, from the deriveStatus method statement and
AssuranceApps-STATUS.md section 3b (AS3):

  1. A lifecycle other than Active answers for itself (Draft, Superseded,
     Not applicable). A missing lifecycle is Active.
  2. No due date and no expiry: 'No date set'.
  3. The permit's expiry has passed: 'Expired', which outranks overdue.
  4. The due date has passed: 'Overdue', whatever evidence was filed.
  5. The nearer of due and expiry (the next action date) is within the
     obligation's lead time (days, inclusive; default 30 when the column
     is null, empty, negative or not a number): 'Due soon'.
  6. Otherwise 'Compliant' when something has been filed
     (last_submitted_date is a date), else 'On track'.

"Passed" = the calendar date is before today; a date equal to today is
not passed. Dates are calendar dates (see oracle_calendar.py).

rollForward: the next due date is the date that WAS due plus the
frequency's months (Monthly 1, Quarterly 3, Semi-annual 6, Annual 12,
Biennial 24), clamped to the target month's last day; One-off, Other
and anything unknown have no next occurrence (None).

byUrgency: worst status first in STATUS_SEVERITY order, then the nearer
next action date, undated last. summarise counts every status and
'attention' = Expired + Overdue + Due soon.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oracle_calendar import (  # noqa: E402
    Cases, D, UNDEF, NAN, js_number, to_date, days_until, add_months, count_by,
    date_family_cases, date_key, truthy,
)

EXPIRED, OVERDUE, DUE_SOON, ON_TRACK, COMPLIANT = 'Expired', 'Overdue', 'Due soon', 'On track', 'Compliant'
NO_DATE, DRAFT, SUPERSEDED, NOT_APPLICABLE = 'No date set', 'Draft', 'Superseded', 'Not applicable'
SEVERITY = [EXPIRED, OVERDUE, DUE_SOON, ON_TRACK, COMPLIANT, NO_DATE, DRAFT, SUPERSEDED, NOT_APPLICABLE]
ATTENTION = [EXPIRED, OVERDUE, DUE_SOON]
MONTHS = {'Monthly': 1, 'Quarterly': 3, 'Semi-annual': 6, 'Annual': 12, 'Biennial': 24}


def lead(o):
    raw = o.get('lead_time_days', UNDEF)
    if raw is None or raw is UNDEF or raw == '':
        return 30
    n = js_number(raw)
    if n != n or n in (float('inf'), float('-inf')) or n < 0:
        return 30
    return n


def next_action(o):
    ds = [d for d in (to_date(o.get('due_date')), to_date(o.get('expiry_date'))) if d is not None]
    return min(ds) if ds else None


def status(o, today):
    lc = o.get('lifecycle') or 'Active'
    if lc in (DRAFT, SUPERSEDED, NOT_APPLICABLE):
        return lc
    t = to_date(today)
    due, exp = to_date(o.get('due_date')), to_date(o.get('expiry_date'))
    if due is None and exp is None:
        return NO_DATE
    if exp is not None and exp < t:
        return EXPIRED
    if due is not None and due < t:
        return OVERDUE
    if (next_action(o) - t).days <= lead(o):
        return DUE_SOON
    return COMPLIANT if to_date(o.get('last_submitted_date')) is not None else ON_TRACK


def explain(o, today):
    nxt = next_action(o)
    return {'status': status(o, today),
            'daysUntil': None if nxt is None else (nxt - to_date(today)).days,
            'nextActionDate': nxt}


def summarise(obs, today):
    by = {s: 0 for s in SEVERITY}
    for o in obs:
        by[status(o, today)] += 1
    return {'total': len(obs), 'byStatus': by, 'attention': sum(by[s] for s in ATTENTION)}


def roll(due, freq):
    d = to_date(due)
    m = MONTHS.get(freq)
    if d is None or not m:
        return None
    return add_months(d, m)


def urgency_order(rows, today):
    return [r['id'] for r in sorted(rows, key=lambda r: (SEVERITY.index(status(r, today)),
                                                        date_key(next_action(r))))]


def build():
    c = Cases('complianceStatus', 'tools/validation/assurance/oracle_compliance.py',
              'Regulatory obligation status, reasons, sort, counts and due-date roll-forward, '
              'from the deriveStatus method statement and STATUS section 3b.')
    T = D('2026-09-17')
    date_family_cases(c, 'cal', T)

    # nextActionDate
    for cid, o in {
        'next-both-due-first': {'due_date': '2026-10-01', 'expiry_date': '2027-01-01'},
        'next-both-expiry-first': {'due_date': '2026-12-01', 'expiry_date': '2026-10-08'},
        'next-both-same': {'due_date': '2026-10-01', 'expiry_date': '2026-10-01'},
        'next-due-only': {'due_date': '2026-10-01'},
        'next-expiry-only': {'expiry_date': '2026-10-01'},
        'next-none': {},
        'next-garbage-due': {'due_date': 'tbc', 'expiry_date': '2027-03-31'},
        'next-date-objects': {'due_date': D('2026-11-01'), 'expiry_date': D('2026-10-31')},
    }.items():
        c.add(cid, 'nextActionDate', [o], next_action(o))
    c.add('next-no-arg', 'nextActionDate', [], None)

    # deriveStatus: every status, every edge
    ds = {
        'st-draft': {'lifecycle': 'Draft', 'due_date': '2020-01-01'},
        'st-superseded': {'lifecycle': 'Superseded', 'expiry_date': '2020-01-01'},
        'st-not-applicable': {'lifecycle': 'Not applicable', 'due_date': '2026-09-18'},
        'st-active-explicit-no-date': {'lifecycle': 'Active'},
        'st-no-lifecycle-no-date': {},
        'st-empty-lifecycle': {'lifecycle': '', 'due_date': '2027-06-01'},
        'st-expired-yesterday': {'expiry_date': '2026-09-16', 'due_date': '2027-01-01'},
        'st-expiry-today': {'expiry_date': '2026-09-17'},
        'st-expired-outranks-overdue': {'expiry_date': '2026-09-01', 'due_date': '2026-08-01'},
        'st-overdue-yesterday': {'due_date': '2026-09-16', 'expiry_date': '2027-09-01'},
        'st-overdue-despite-filing': {'due_date': '2026-09-10', 'last_submitted_date': '2026-03-01'},
        'st-due-today': {'due_date': '2026-09-17'},
        'st-due-today-filed': {'due_date': '2026-09-17', 'last_submitted_date': '2026-06-17'},
        'st-lead-edge-30': {'due_date': '2026-10-17'},
        'st-lead-edge-31': {'due_date': '2026-10-18'},
        'st-lead-edge-31-filed': {'due_date': '2026-10-18', 'last_submitted_date': '2026-07-18'},
        'st-expiry-drives-soon': {'due_date': '2027-03-01', 'expiry_date': '2026-10-01',
                                  'last_submitted_date': '2026-03-01'},
        'st-lead-90-inside': {'due_date': '2026-12-16', 'lead_time_days': 90},
        'st-lead-90-outside': {'due_date': '2026-12-17', 'lead_time_days': 90},
        'st-lead-7-inside': {'due_date': '2026-09-24', 'lead_time_days': 7},
        'st-lead-7-outside': {'due_date': '2026-09-25', 'lead_time_days': 7},
        'st-lead-zero-today': {'due_date': '2026-09-17', 'lead_time_days': 0},
        'st-lead-zero-tomorrow': {'due_date': '2026-09-18', 'lead_time_days': 0},
        'st-lead-null-default': {'due_date': '2026-10-10', 'lead_time_days': None},
        'st-lead-empty-default': {'due_date': '2026-10-10', 'lead_time_days': ''},
        'st-lead-negative-default': {'due_date': '2026-10-10', 'lead_time_days': -5},
        'st-lead-text-default': {'due_date': '2026-10-10', 'lead_time_days': 'soon'},
        'st-lead-string-number': {'due_date': '2026-10-10', 'lead_time_days': '10'},
        'st-lead-nan-default': {'due_date': '2026-10-10', 'lead_time_days': NAN},
        'st-compliant': {'due_date': '2027-09-17', 'last_submitted_date': '2026-09-15'},
        'st-on-track': {'due_date': '2027-09-17'},
        'st-garbage-evidence': {'due_date': '2027-09-17', 'last_submitted_date': 'n/a'},
        'st-garbage-dates': {'due_date': 'tbc', 'expiry_date': 'never'},
        'st-dst-us': {'due_date': '2026-04-07'},
        'st-date-objects': {'due_date': D('2026-09-16')},
    }
    for cid, o in ds.items():
        c.add(cid, 'deriveStatus', [o, T], status(o, today=T))
    c.add('st-dst-us-lead-edge', 'deriveStatus', [{'due_date': '2026-04-07'}, D('2026-03-08')], DUE_SOON)
    c.add('st-dst-nz-lead-edge', 'deriveStatus', [{'due_date': '2026-10-27', 'last_submitted_date': '2026-01-01'},
                                                   D('2026-09-27')], DUE_SOON)
    c.add('st-no-arg', 'deriveStatus', [UNDEF, T], NO_DATE)
    # rule taken from the code, not the docs: an unknown lifecycle is tracked as Active
    c.add('st-unknown-lifecycle', 'deriveStatus', [{'lifecycle': 'Archived', 'due_date': '2026-09-01'}, T], OVERDUE)
    # CAL-1 knock-on: an impossible expiry is no expiry
    c.add('st-impossible-expiry', 'deriveStatus',
          [{'expiry_date': '2026-09-31', 'due_date': '2027-06-01', 'last_submitted_date': '2026-06-01'}, T],
          COMPLIANT, defect='CAL-1')
    c.add('st-impossible-evidence', 'deriveStatus',
          [{'due_date': '2027-06-01', 'last_submitted_date': '2026-02-30'}, T], ON_TRACK, defect='CAL-1')

    # explainStatus: status, daysUntil, nextActionDate (reason is prose)
    for cid in ['st-draft', 'st-expired-yesterday', 'st-overdue-yesterday', 'st-due-today', 'st-lead-edge-30',
                'st-compliant', 'st-on-track', 'st-no-lifecycle-no-date', 'st-expiry-drives-soon',
                'st-expired-outranks-overdue', 'st-superseded', 'st-not-applicable']:
        o = ds[cid]
        c.add('ex' + cid[2:], 'explainStatus', [o, T], explain(o, T))

    # byUrgency
    rows = [
        {'id': 'na', 'lifecycle': 'Not applicable'},
        {'id': 'ontrack-far', 'due_date': '2027-08-01'},
        {'id': 'compliant', 'due_date': '2027-02-01', 'last_submitted_date': '2026-02-01'},
        {'id': 'overdue-old', 'due_date': '2026-01-01'},
        {'id': 'draft', 'lifecycle': 'Draft', 'due_date': '2026-01-01'},
        {'id': 'soon-late', 'due_date': '2026-10-10'},
        {'id': 'expired', 'expiry_date': '2026-09-01'},
        {'id': 'nodate', },
        {'id': 'soon-early', 'expiry_date': '2026-09-20', 'due_date': '2027-01-01'},
        {'id': 'overdue-recent', 'due_date': '2026-09-16'},
        {'id': 'superseded', 'lifecycle': 'Superseded'},
        {'id': 'ontrack-near', 'due_date': '2026-11-01'},
    ]
    c.sort('urgency-mixed', 'byUrgency', rows, urgency_order(rows, T), factory_args=[T])
    ties = [
        {'id': 'draft-undated', 'lifecycle': 'Draft'},
        {'id': 'draft-late', 'lifecycle': 'Draft', 'due_date': '2027-01-01'},
        {'id': 'draft-undated-2', 'lifecycle': 'Draft'},
        {'id': 'draft-early', 'lifecycle': 'Draft', 'expiry_date': '2026-01-01'},
    ]
    c.sort('urgency-ties-in-status', 'byUrgency', ties, urgency_order(ties, T), factory_args=[T])
    c.sort('urgency-empty', 'byUrgency', [], [], factory_args=[T])

    # summarise
    c.add('summary-mixed', 'summarise', [rows, T], summarise(rows, T))
    c.add('summary-empty', 'summarise', [[], T], summarise([], T))
    c.add('summary-no-attention', 'summarise', [ties, T], summarise(ties, T))

    # countBy
    obs = [{'regime': 'Environmental'}, {'regime': 'Licensing'}, {'regime': ''},
           {'regime': 'Environmental'}, {}, {'regime': 'Licensing'}, {'regime': 'Environmental'},
           {'regime': None}, {'regime': 'Reporting'}]
    c.add('countby-regime', 'countBy', [obs, 'regime'], count_by(obs, 'regime'))
    c.add('countby-custom-unset', 'countBy', [obs, 'regime', 'No regime'], count_by(obs, 'regime', 'No regime'))
    c.add('countby-missing-field', 'countBy', [obs, 'authority'], count_by(obs, 'authority'))
    c.add('countby-empty', 'countBy', [[], 'regime'], [])

    # rollForward
    rf = [
        ('roll-monthly', '2026-09-17', 'Monthly'),
        ('roll-quarterly', '2026-09-17', 'Quarterly'),
        ('roll-semiannual', '2026-09-17', 'Semi-annual'),
        ('roll-annual', '2026-09-17', 'Annual'),
        ('roll-biennial', '2026-09-17', 'Biennial'),
        ('roll-jan31-monthly', '2026-01-31', 'Monthly'),
        ('roll-jan31-monthly-leap', '2028-01-31', 'Monthly'),
        ('roll-aug31-quarterly', '2026-08-31', 'Quarterly'),
        ('roll-mar31-semiannual', '2026-03-31', 'Semi-annual'),
        ('roll-leapday-annual', '2028-02-29', 'Annual'),
        ('roll-leapday-biennial', '2028-02-29', 'Biennial'),
        ('roll-dec-monthly', '2026-12-15', 'Monthly'),
        ('roll-nov30-quarterly', '2026-11-30', 'Quarterly'),
        ('roll-oct31-monthly', '2026-10-31', 'Monthly'),
        ('roll-across-dst', '2026-03-08', 'Monthly'),
    ]
    for cid, d, f in rf:
        c.add(cid, 'rollForward', [d, f], roll(d, f))
    c.add('roll-date-object', 'rollForward', [D('2026-05-31'), 'Monthly'], roll('2026-05-31', 'Monthly'))
    for cid, d, f in [('roll-one-off', '2026-09-17', 'One-off'), ('roll-other', '2026-09-17', 'Other'),
                      ('roll-unknown', '2026-09-17', 'Weekly'), ('roll-no-freq', '2026-09-17', None),
                      ('roll-no-date', None, 'Annual'), ('roll-garbage-date', 'soon', 'Annual')]:
        c.add(cid, 'rollForward', [d, f], None)
    c.add('roll-impossible-date', 'rollForward', ['2026-02-30', 'Monthly'], None, defect='CAL-1')
    return c


if __name__ == '__main__':
    build().write('complianceStatus_cases.json')
