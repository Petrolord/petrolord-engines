#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/managementOfChange.js (AS12).

Written from the METHOD STATEMENTS, not from the JavaScript:
  - the module docstrings (three rules: multi-level approval gate,
    pre-implementation actions before implementation / implementation and
    post-implementation actions before closure, a temporary change past its
    expiry is EXPIRED);
  - docs/scope/AssuranceApps-STATUS.md section 3e (AS6), in particular
    "an empty approval list is not a passed gate";
  - calendar.js's contract: a 'YYYY-MM-DD' is a calendar date, an unreadable
    date is no date, and whole days separate two calendar dates. Python's
    datetime.date is the independent model of that.
  - CCPS MOC practice: a temporary change must carry a date to come back out.

Rules taken from the code rather than the docs are listed in
FINDINGS-moc.md. Stdlib only. Run:  python3 tools/validation/assurance/oracle_moc.py
"""
import datetime as dt
import functools
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'assurance', 'goldens',
                   'managementOfChange_cases.json')

# ---------------------------------------------------------------- values


def D(s):
    return {'$date': s}


UNDEF = {'$undefined': True}
INVALID_DATE = {'$date': None}


def js_truthy(v):
    """JavaScript truthiness for the JSON values these cases use."""
    if v is None or v is False:
        return False
    if isinstance(v, dict) and v.get('$undefined'):
        return False
    if isinstance(v, dict) and '$num' in v:
        return v['$num'] != 'NaN'
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0
    if isinstance(v, str):
        return v != ''
    return True  # objects, arrays, dates (even Invalid Date) are truthy


def cal_date(v):
    """A calendar date from a $date tag or a string beginning YYYY-MM-DD.

    Out-of-range strings (30 February, month 13) are not dates, which is
    what calendar.js's docstring promises: 'an unreadable date is no date'.
    """
    if not js_truthy(v):
        return None
    if isinstance(v, dict) and '$date' in v:
        if v['$date'] is None:
            return None
        return dt.date.fromisoformat(v['$date'])
    if isinstance(v, dt.date):
        return v
    if isinstance(v, (dict, list)):
        return None
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', str(v))
    if not m:
        return None
    try:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def days_until(v, today):
    d = cal_date(v)
    if d is None:
        return None
    return (d - cal_date(today)).days


def out_date(d):
    return None if d is None else {'$date': d.isoformat()}


def get(o, k):
    if o is None:
        return None
    v = o.get(k)
    if isinstance(v, dict) and v.get('$undefined'):
        return None
    return v


# ---------------------------------------------------------------- the rules

ACTIVE = ['Draft', 'Screening', 'Review', 'Approval', 'Implementation']
ALL_STAGES = ACTIVE + ['Closed', 'Rejected', 'Cancelled']
RISKS = ['Low', 'Medium', 'High', 'Critical']
EXPIRING = ['Temporary', 'Emergency']
LEAD = 14
DONE = ['Complete', 'Cancelled']

# The legal workflow. The docs name the stages but not the edges; this
# table is taken from the code (FINDINGS-moc.md, R1). What the docs DO
# fix, and what the cases check independently: terminal stages go
# nowhere, and nothing reaches Implementation except from Approval.
EDGES = {
    'Draft': ['Screening', 'Cancelled'],
    'Screening': ['Review', 'Rejected', 'Cancelled', 'Draft'],
    'Review': ['Approval', 'Rejected', 'Cancelled', 'Screening'],
    'Approval': ['Implementation', 'Rejected', 'Cancelled', 'Review'],
    'Implementation': ['Closed', 'Cancelled'],
    'Closed': [], 'Rejected': [], 'Cancelled': [],
}


def o_next_stages(stage):
    return list(EDGES.get(stage, [])) if isinstance(stage, str) else []


def o_expiry_state(moc, today):
    moc = moc or {}
    if get(moc, 'type') not in EXPIRING:
        return 'Permanent change'
    stage = get(moc, 'stage')
    # Only a change on the facility can breach its expiry. A closed
    # temporary change has been closed out (rule from the code, R2).
    if stage == 'Implementation':
        n = days_until(get(moc, 'expiry_date'), today)
        if n is None:
            return 'No expiry'
        if n < 0:
            return 'Expired'
        if n <= LEAD:
            return 'Expiring soon'
        return 'Within expiry'
    if stage == 'Closed':
        return 'Closed out'  # AS13-0: a closed temporary change is closed out
    return 'No expiry'


def o_is_expired(moc, today):
    return o_expiry_state(moc, today) == 'Expired'


def o_is_overdue(moc, today):
    moc = moc or {}
    if get(moc, 'stage') not in ACTIVE:
        return False
    n = days_until(get(moc, 'target_implementation_date'), today)
    return n is not None and n < 0


def level_of(a):
    lv = get(a, 'level')
    return 1 if lv is None else lv


def o_approval_state(approvals):
    levels = sorted({level_of(a) for a in approvals})
    rejected = [a for a in approvals if get(a, 'status') == 'Rejected']
    outstanding = [lv for lv in levels
                   if not any(level_of(a) == lv and get(a, 'status') == 'Approved' for a in approvals)]
    return {
        'levels': levels,
        'rejected': rejected,
        'outstanding': outstanding,
        'complete': bool(levels) and not outstanding and not rejected,
    }


def still_open(actions, kind):
    return [a for a in actions if get(a, 'action_type') == kind and get(a, 'status') not in DONE]


def o_can_advance(moc, to, ctx=None):
    moc = moc or {}
    ctx = ctx or {}
    approvals = ctx.get('approvals') or []
    actions = ctx.get('actions') or []
    if to not in o_next_stages(get(moc, 'stage')):
        return {'ok': False}
    if to == 'Implementation':
        st = o_approval_state(approvals)
        if not st['complete']:
            return {'ok': False}
        if still_open(actions, 'Pre-implementation'):
            return {'ok': False}
        if get(moc, 'type') in EXPIRING and cal_date(get(moc, 'expiry_date')) is None:
            return {'ok': False}
    if to == 'Closed':
        if still_open(actions, 'Implementation') or still_open(actions, 'Post-implementation'):
            return {'ok': False}
    return {'ok': True}


def o_summarise(records, ctx, today):
    ctx = ctx or {}
    actions = ctx.get('actions') or []
    by_stage = {s: sum(1 for m in records if get(m, 'stage') == s) for s in ALL_STAGES}
    by_risk = {r: sum(1 for m in records if get(m, 'risk_level') == r) for r in RISKS}
    open_actions = [a for a in actions if get(a, 'status') not in DONE]
    overdue_actions = [a for a in open_actions
                       if (days_until(get(a, 'due_date'), today) or 0) < 0]
    return {
        'total': len(records),
        'byStage': by_stage,
        'byRisk': by_risk,
        'active': sum(1 for m in records if get(m, 'stage') in ACTIVE),
        'awaitingApproval': sum(1 for m in records if get(m, 'stage') == 'Approval'),
        'expired': sum(1 for m in records if o_expiry_state(m, today) == 'Expired'),
        'expiringSoon': sum(1 for m in records if o_expiry_state(m, today) == 'Expiring soon'),
        'overdue': sum(1 for m in records if o_is_overdue(m, today)),
        'openActions': len(open_actions),
        'overdueActions': len(overdue_actions),
    }


def o_count_by(rows, field, unset='Unspecified'):
    if isinstance(unset, dict) and unset.get('$undefined'):
        unset = 'Unspecified'
    seen = []
    counts = {}
    for r in rows:
        v = r.get(field) if isinstance(r, dict) else None
        key = v if js_truthy(v) else unset
        k = json.dumps(key, sort_keys=True)
        if k not in counts:
            seen.append((k, key))
            counts[k] = 0
        counts[k] += 1
    out = [{'name': key, 'count': counts[k]} for k, key in seen]
    return sorted(out, key=lambda x: -x['count'])  # stable: first seen wins a tie


def urgency_order(rows, today):
    """Expired first, then expiring soon, then overdue, then live work,
    then finished. Within a rank, earliest date first (the expiry date if
    the change has one, else the target date), undated last."""
    def rank(m):
        s = o_expiry_state(m, today)
        if s == 'Expired':
            return 0
        if s == 'Expiring soon':
            return 1
        if o_is_overdue(m, today):
            return 2
        if get(m, 'stage') in ACTIVE:
            return 3
        return 4

    def key_date(m):
        e = get(m, 'expiry_date')
        return cal_date(e if js_truthy(e) else get(m, 'target_implementation_date'))

    def cmp(a, b):
        ra, rb = rank(a), rank(b)
        if ra != rb:
            return ra - rb
        da, db = key_date(a), key_date(b)
        if da and db:
            return (da - db).days
        if da:
            return -1
        if db:
            return 1
        return 0
    return [r['id'] for r in sorted(rows, key=functools.cmp_to_key(cmp))]


# ---------------------------------------------------------------- the cases

cases = []


def case(cid, fn, args, expected, defect=None):
    c = {'id': cid, 'fn': fn, 'args': args, 'expected': expected}
    if defect:
        c['repaired'] = defect
    cases.append(c)


def sort_case(cid, rows, today, defect=None):
    c = {'id': cid, 'sort': 'byUrgency', 'factory': True, 'factoryArgs': [today],
         'rows': rows, 'expectedOrder': urgency_order(rows, today)}
    if defect:
        c['repaired'] = defect
    cases.append(c)


T = D('2026-09-18')
TODAY = dt.date(2026, 9, 18)


def iso(n):
    return (TODAY + dt.timedelta(days=n)).isoformat()


# --- calendar helpers, re-exported
for cid, v in [
    ('parse-plain', '2026-09-18'), ('parse-timestamp-prefix', '2026-09-17T23:30:00Z'),
    ('parse-date-object', D('2026-02-28')), ('parse-null', None), ('parse-empty', ''),
    ('parse-garbage', 'next shutdown'), ('parse-invalid-date', INVALID_DATE),
    ('parse-leap-day', '2028-02-29'), ('parse-us-format', '09/18/2026'),
]:
    case(cid, 'parseDateOnly', [v], out_date(cal_date(v)))
# 30 February and month 13 are not calendar dates (CAL-1, calendar.js; see FINDINGS-moc.md)
case('parse-30-february', 'parseDateOnly', ['2026-02-30'], None, 'CAL-1')
case('parse-month-13', 'parseDateOnly', ['2026-13-01'], None, 'CAL-1')
case('parse-non-leap-29-feb', 'parseDateOnly', ['2027-02-29'], None, 'CAL-1')

for cid, v, t in [
    ('days-today', '2026-09-18', T), ('days-tomorrow', '2026-09-19', T),
    ('days-yesterday', '2026-09-17', T), ('days-across-year', '2027-01-01', T),
    ('days-across-us-dst-end', '2026-11-02', D('2026-10-31')),
    ('days-across-eu-dst-start', '2026-03-30', D('2026-03-28')),
    ('days-across-nz-dst-start', '2026-09-28', D('2026-09-26')),
    ('days-null', None, T), ('days-garbage', 'soon', T),
    ('days-date-object', D('2026-10-18'), T),
]:
    case(cid, 'daysUntil', [v, t], days_until(v, t))
case('days-30-february', 'daysUntil', ['2026-02-30', T], None, 'CAL-1')

for cid, v in [('tods-string', '2026-09-18T10:00:00Z'), ('tods-date', D('2026-01-05')),
               ('tods-null', None), ('tods-garbage', 'x')]:
    d = cal_date(v)
    case(cid, 'toDateOnlyString', [v], None if d is None else d.isoformat())
case('tods-30-february', 'toDateOnlyString', ['2026-02-30'], None, 'CAL-1')

# --- nextStages: every stage, and one that is not a stage
for s in ALL_STAGES + ['Approved', None]:
    case(f'next-{s}', 'nextStages', [s], o_next_stages(s))

# --- expiryState / isExpired: every type x every stage, at the boundaries
exp_offsets = {'past-1': -1, 'today': 0, 'lead-edge': LEAD, 'lead-plus-1': LEAD + 1, 'far': 200,
               'past-400': -400}
for typ in ['Permanent', 'Temporary', 'Emergency', None]:
    for stage in ALL_STAGES:
        for tag, off in exp_offsets.items():
            if stage not in ('Implementation', 'Review', 'Closed') and tag not in ('past-1',):
                continue
            moc = {'type': typ, 'stage': stage, 'expiry_date': iso(off)}
            case(f'expiry-{typ}-{stage}-{tag}', 'expiryState', [moc, T], o_expiry_state(moc, T))
for typ in ['Temporary', 'Emergency']:
    for v, tag in [(None, 'null'), ('', 'empty'), (UNDEF, 'undefined')]:
        moc = {'type': typ, 'stage': 'Implementation', 'expiry_date': v}
        case(f'expiry-{typ}-no-date-{tag}', 'expiryState', [moc, T], o_expiry_state(moc, T))
case('expiry-empty-object', 'expiryState', [{}, T], o_expiry_state({}, T))
# An unreadable expiry date is no expiry date (MOC-1)
bad = {'type': 'Temporary', 'stage': 'Implementation', 'expiry_date': 'after turnaround'}
case('expiry-unreadable-date', 'expiryState', [bad, T], o_expiry_state(bad, T), 'MOC-1')
bad2 = {'type': 'Emergency', 'stage': 'Implementation', 'expiry_date': '2026-02-30'}
case('expiry-30-february', 'expiryState', [bad2, T], o_expiry_state(bad2, T), 'MOC-1,CAL-1')

for tag, moc in [
    ('temp-impl-past', {'type': 'Temporary', 'stage': 'Implementation', 'expiry_date': iso(-1)}),
    ('temp-impl-today', {'type': 'Temporary', 'stage': 'Implementation', 'expiry_date': iso(0)}),
    ('emerg-impl-past', {'type': 'Emergency', 'stage': 'Implementation', 'expiry_date': iso(-30)}),
    ('temp-review-past', {'type': 'Temporary', 'stage': 'Review', 'expiry_date': iso(-30)}),
    ('temp-closed-past', {'type': 'Temporary', 'stage': 'Closed', 'expiry_date': iso(-30)}),
    ('temp-cancelled-past', {'type': 'Temporary', 'stage': 'Cancelled', 'expiry_date': iso(-30)}),
    ('perm-impl-past', {'type': 'Permanent', 'stage': 'Implementation', 'expiry_date': iso(-30)}),
    ('temp-impl-date-object', {'type': 'Temporary', 'stage': 'Implementation', 'expiry_date': D(iso(-2))}),
]:
    case(f'isExpired-{tag}', 'isExpired', [moc, T], o_is_expired(moc, T))

# --- isOverdue
for stage in ALL_STAGES:
    for tag, off in [('past', -1), ('today', 0)]:
        moc = {'stage': stage, 'target_implementation_date': iso(off)}
        case(f'overdue-{stage}-{tag}', 'isOverdue', [moc, T], o_is_overdue(moc, T))
for tag, v in [('null', None), ('garbage', 'Q4'), ('invalid-date', INVALID_DATE)]:
    moc = {'stage': 'Review', 'target_implementation_date': v}
    case(f'overdue-review-{tag}', 'isOverdue', [moc, T], o_is_overdue(moc, T))
case('overdue-empty', 'isOverdue', [{}, T], False)

# --- approvalState
A = lambda i, lv, st: {'id': i, 'level': lv, 'status': st}  # noqa: E731
approval_sets = {
    'empty': [],
    'one-approved': [A('a1', 1, 'Approved')],
    'one-pending': [A('a1', 1, 'Pending')],
    'one-delegated': [A('a1', 1, 'Delegated')],
    'two-levels-both': [A('a2', 2, 'Approved'), A('a1', 1, 'Approved')],
    'two-levels-l2-pending': [A('a1', 1, 'Approved'), A('a2', 2, 'Pending')],
    'level-any-one-signs': [A('a1', 1, 'Pending'), A('a2', 1, 'Approved'), A('a3', 2, 'Approved')],
    'rejected-beside-approved': [A('a1', 1, 'Approved'), A('a2', 1, 'Rejected')],
    'rejected-only': [A('a1', 3, 'Rejected')],
    'level-default-one': [{'id': 'a1', 'status': 'Approved'}, {'id': 'a2', 'level': None, 'status': 'Pending'}],
    'unsorted-three': [A('a3', 3, 'Pending'), A('a1', 1, 'Approved'), A('a2', 2, 'Delegated'), A('a4', 10, 'Approved')],
}
for tag, rows in approval_sets.items():
    case(f'approvals-{tag}', 'approvalState', [rows], o_approval_state(rows))
case('approvals-default-arg', 'approvalState', [UNDEF], o_approval_state([]))

# --- canAdvance
temp_ready = {'type': 'Temporary', 'stage': 'Approval', 'expiry_date': iso(90)}
perm_ready = {'type': 'Permanent', 'stage': 'Approval'}
signed = [A('a1', 1, 'Approved'), A('a2', 2, 'Approved')]
pre_done = [{'action_type': 'Pre-implementation', 'status': 'Complete'},
            {'action_type': 'Pre-implementation', 'status': 'Cancelled'},
            {'action_type': 'Post-implementation', 'status': 'Open'}]
adv = [
    ('illegal-skip-to-impl', {'stage': 'Review', 'type': 'Permanent'}, 'Implementation', {'approvals': signed}),
    ('illegal-draft-to-approval', {'stage': 'Draft'}, 'Approval', {}),
    ('closed-final', {'stage': 'Closed'}, 'Draft', {}),
    ('rejected-final', {'stage': 'Rejected'}, 'Review', {}),
    ('cancelled-final', {'stage': 'Cancelled'}, 'Draft', {}),
    ('unknown-stage', {'stage': 'Approved'}, 'Implementation', {'approvals': signed}),
    ('not-a-stage-target', {'stage': 'Draft'}, 'Approved', {}),
    ('draft-to-screening', {'stage': 'Draft'}, 'Screening', {}),
    ('draft-cancel', {'stage': 'Draft'}, 'Cancelled', {}),
    ('screening-back-to-draft', {'stage': 'Screening'}, 'Draft', {}),
    ('review-to-approval', {'stage': 'Review'}, 'Approval', {}),
    ('approval-back-to-review', {'stage': 'Approval'}, 'Review', {}),
    ('approval-reject-no-approvers', {'stage': 'Approval'}, 'Rejected', {}),
    ('impl-empty-approvals', perm_ready, 'Implementation', {'approvals': []}),
    ('impl-no-context', perm_ready, 'Implementation', UNDEF),
    ('impl-all-signed', perm_ready, 'Implementation', {'approvals': signed}),
    ('impl-level2-pending', perm_ready, 'Implementation', {'approvals': approval_sets['two-levels-l2-pending']}),
    ('impl-only-delegated', perm_ready, 'Implementation', {'approvals': approval_sets['one-delegated']}),
    ('impl-rejection-against', perm_ready, 'Implementation', {'approvals': approval_sets['rejected-beside-approved']}),
    ('impl-pre-open', perm_ready, 'Implementation', {'approvals': signed, 'actions': [
        {'action_type': 'Pre-implementation', 'status': 'In progress'}]}),
    ('impl-pre-no-status', perm_ready, 'Implementation', {'approvals': signed, 'actions': [
        {'action_type': 'Pre-implementation'}]}),
    ('impl-pre-closed-post-open', perm_ready, 'Implementation', {'approvals': signed, 'actions': pre_done}),
    ('impl-temp-with-expiry', temp_ready, 'Implementation', {'approvals': signed, 'actions': pre_done}),
    ('impl-temp-no-expiry', {'type': 'Temporary', 'stage': 'Approval'}, 'Implementation', {'approvals': signed}),
    ('impl-emergency-no-expiry', {'type': 'Emergency', 'stage': 'Approval', 'expiry_date': ''}, 'Implementation', {'approvals': signed}),
    ('impl-emergency-with-expiry', {'type': 'Emergency', 'stage': 'Approval', 'expiry_date': iso(7)}, 'Implementation', {'approvals': signed}),
    ('impl-temp-expiry-already-past', {'type': 'Temporary', 'stage': 'Approval', 'expiry_date': iso(-3)}, 'Implementation', {'approvals': signed}),
    ('close-all-done', {'stage': 'Implementation'}, 'Closed', {'actions': [
        {'action_type': 'Implementation', 'status': 'Complete'},
        {'action_type': 'Post-implementation', 'status': 'Cancelled'},
        {'action_type': 'Pre-implementation', 'status': 'Open'}]}),
    ('close-post-open', {'stage': 'Implementation'}, 'Closed', {'actions': [
        {'action_type': 'Post-implementation', 'status': 'Open'}]}),
    ('close-impl-action-open', {'stage': 'Implementation'}, 'Closed', {'actions': [
        {'action_type': 'Implementation', 'status': 'In progress'}]}),
    ('close-no-actions', {'stage': 'Implementation', 'type': 'Temporary', 'expiry_date': iso(-5)}, 'Closed', {}),
    ('impl-cancel', {'stage': 'Implementation'}, 'Cancelled', {'actions': [
        {'action_type': 'Post-implementation', 'status': 'Open'}]}),
    ('impl-back-to-approval', {'stage': 'Implementation'}, 'Approval', {}),
]
for tag, moc, to, ctx in adv:
    case(f'advance-{tag}', 'canAdvance', [moc, to, ctx],
         o_can_advance(moc, to, None if isinstance(ctx, dict) and ctx.get('$undefined') else ctx))
# An unreadable expiry date is not a date to come back out by (MOC-1)
bad_temp = {'type': 'Temporary', 'stage': 'Approval', 'expiry_date': 'next shutdown'}
case('advance-impl-temp-unreadable-expiry', 'canAdvance', [bad_temp, 'Implementation', {'approvals': signed}],
     o_can_advance(bad_temp, 'Implementation', {'approvals': signed}), 'MOC-1')

# --- summarise
records = [
    {'id': 'm1', 'stage': 'Implementation', 'type': 'Temporary', 'risk_level': 'High', 'expiry_date': iso(-10), 'target_implementation_date': iso(-40)},
    {'id': 'm2', 'stage': 'Implementation', 'type': 'Emergency', 'risk_level': 'Critical', 'expiry_date': iso(LEAD)},
    {'id': 'm3', 'stage': 'Implementation', 'type': 'Temporary', 'risk_level': 'Medium', 'expiry_date': iso(LEAD + 1)},
    {'id': 'm4', 'stage': 'Approval', 'type': 'Permanent', 'risk_level': 'Low', 'target_implementation_date': iso(-1)},
    {'id': 'm5', 'stage': 'Approval', 'type': 'Temporary', 'risk_level': 'High', 'expiry_date': iso(-100), 'target_implementation_date': iso(0)},
    {'id': 'm6', 'stage': 'Closed', 'type': 'Temporary', 'risk_level': 'Low', 'expiry_date': iso(-100), 'target_implementation_date': iso(-200)},
    {'id': 'm7', 'stage': 'Cancelled', 'type': 'Emergency', 'risk_level': 'Critical', 'expiry_date': iso(-5), 'target_implementation_date': iso(-5)},
    {'id': 'm8', 'stage': 'Rejected', 'type': 'Permanent', 'risk_level': 'Extreme'},
    {'id': 'm9', 'stage': 'Draft', 'type': 'Permanent', 'target_implementation_date': iso(-3)},
    {'id': 'm10', 'stage': 'Screening', 'type': 'Permanent', 'risk_level': 'Medium', 'target_implementation_date': 'TBC'},
    {'id': 'm11', 'stage': 'Review', 'type': 'Permanent', 'risk_level': 'Low'},
    {'id': 'm12', 'stage': 'Archived', 'type': 'Permanent', 'risk_level': 'Low', 'target_implementation_date': iso(-9)},
    {'id': 'm13', 'stage': 'Implementation', 'type': 'Temporary', 'risk_level': 'High', 'expiry_date': iso(0)},
]
actions = [
    {'status': 'Open', 'due_date': iso(-1)},
    {'status': 'In progress', 'due_date': iso(0)},
    {'status': 'Complete', 'due_date': iso(-20)},
    {'status': 'Cancelled', 'due_date': iso(-20)},
    {'status': 'Open'},
    {'status': 'Open', 'due_date': 'someday'},
    {'due_date': iso(-2)},
]
case('summarise-register', 'summarise', [records, {'actions': actions}, T],
     o_summarise(records, {'actions': actions}, T))
case('summarise-empty', 'summarise', [[], {}, T], o_summarise([], {}, T))
case('summarise-no-context', 'summarise', [records[:4], UNDEF, T], o_summarise(records[:4], {}, T))
case('summarise-only-finished', 'summarise', [[records[5], records[6], records[7]], {'actions': actions[2:4]}, T],
     o_summarise([records[5], records[6], records[7]], {'actions': actions[2:4]}, T))
case('summarise-lead-edge-moves-a-day-later', 'summarise', [records, {}, D(iso(1))],
     o_summarise(records, {}, D(iso(1))))
case('summarise-unreadable-expiry', 'summarise', [[bad | {'stage': 'Implementation'}], {}, T],
     o_summarise([bad], {}, T), 'MOC-1')

# --- countBy
rows = [{'category': 'Software or IT'}, {'category': 'Facility or hardware'}, {'category': ''},
        {'category': 'Facility or hardware'}, {}, {'category': None}, {'category': 'Other'},
        {'category': 'Software or IT'}, {'category': 'Software or IT'}]
case('countBy-category', 'countBy', [rows, 'category'], o_count_by(rows, 'category'))
case('countBy-custom-unset', 'countBy', [rows, 'category', 'None given'], o_count_by(rows, 'category', 'None given'))
case('countBy-empty', 'countBy', [[], 'category'], [])
case('countBy-tie-keeps-first-seen', 'countBy', [[{'r': 'B'}, {'r': 'A'}, {'r': 'A'}, {'r': 'B'}, {'r': 'C'}], 'r'],
     o_count_by([{'r': 'B'}, {'r': 'A'}, {'r': 'A'}, {'r': 'B'}, {'r': 'C'}], 'r'))
case('countBy-null-row', 'countBy', [[None, {'stage': 'Draft'}], 'stage'], o_count_by([None, {'stage': 'Draft'}], 'stage'))

# --- byUrgency
urg_rows = [
    {'id': 'finished', 'stage': 'Closed', 'type': 'Permanent', 'target_implementation_date': iso(-300)},
    {'id': 'live-late', 'stage': 'Review', 'type': 'Permanent', 'target_implementation_date': iso(40)},
    {'id': 'overdue-b', 'stage': 'Review', 'type': 'Permanent', 'target_implementation_date': iso(-2)},
    {'id': 'expired-b', 'stage': 'Implementation', 'type': 'Temporary', 'expiry_date': iso(-1)},
    {'id': 'expiring', 'stage': 'Implementation', 'type': 'Emergency', 'expiry_date': iso(3)},
    {'id': 'live-undated', 'stage': 'Draft', 'type': 'Permanent'},
    {'id': 'overdue-a', 'stage': 'Approval', 'type': 'Permanent', 'target_implementation_date': iso(-20)},
    {'id': 'expired-a', 'stage': 'Implementation', 'type': 'Emergency', 'expiry_date': iso(-50)},
    {'id': 'live-soon', 'stage': 'Screening', 'type': 'Permanent', 'target_implementation_date': iso(5)},
    {'id': 'rejected', 'stage': 'Rejected', 'type': 'Temporary', 'expiry_date': iso(-9)},
    {'id': 'within', 'stage': 'Implementation', 'type': 'Temporary', 'expiry_date': iso(100)},
]
sort_case('urgency-register', urg_rows, T)
sort_case('urgency-empty', [], T)
sort_case('urgency-lead-edge', [
    {'id': 'edge-plus-1', 'stage': 'Implementation', 'type': 'Temporary', 'expiry_date': iso(LEAD + 1)},
    {'id': 'edge', 'stage': 'Implementation', 'type': 'Temporary', 'expiry_date': iso(LEAD)},
    {'id': 'expired-today-minus-1', 'stage': 'Implementation', 'type': 'Temporary', 'expiry_date': iso(-1)},
    {'id': 'today', 'stage': 'Implementation', 'type': 'Temporary', 'expiry_date': iso(0)},
], T)

golden = {
    'module': 'managementOfChange',
    'generatedBy': 'tools/validation/assurance/oracle_moc.py',
    'description': 'Independent stdlib-Python oracle for the MOC rules: expiry of temporary and '
                   'emergency changes (lead window 14 days), the multi-level approval gate where '
                   'an empty approval list is not a passed gate, action ordering before '
                   'implementation and closure, the dashboard summary and the urgency sort. '
                   'Findings: FINDINGS-moc.md.',
    'cases': cases,
}

if __name__ == '__main__':
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(golden, f, indent=1)
        f.write('\n')
    print(f'{len(cases)} cases -> {os.path.normpath(OUT)}')
