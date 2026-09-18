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


# ASC-0 RC-3: overdue against the target implementation date is a
# question only BEFORE the change is on the facility. Implementation is
# in effect (its expiry runs, IN_EFFECT below), so it is not late to be
# implemented; late work there is carried by overdue actions.
PRE_EFFECT = ['Draft', 'Screening', 'Review', 'Approval']


def o_is_overdue(moc, today):
    moc = moc or {}
    if get(moc, 'stage') not in PRE_EFFECT:
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
        # AS15 Q9: an Emergency change needs only its LOWEST approval level
        # signed (and no rejection) before it goes in; the rest ratify after.
        emergency_ok = (get(moc, 'type') == 'Emergency' and bool(st['levels'])
                        and not st['rejected'] and st['levels'][0] not in st['outstanding'])
        if not st['complete'] and not emergency_ok:
            return {'ok': False}
        if still_open(actions, 'Pre-implementation'):
            return {'ok': False}
        if get(moc, 'type') in EXPIRING and cal_date(get(moc, 'expiry_date')) is None:
            return {'ok': False}
    if to == 'Closed':
        # AS15 Q9: an emergency change cannot close until every level ratified.
        if get(moc, 'type') == 'Emergency' and not o_approval_state(approvals)['complete']:
            return {'ok': False}
        if still_open(actions, 'Implementation') or still_open(actions, 'Post-implementation'):
            return {'ok': False}
    return {'ok': True}


RATIFY_DAYS = 7
IN_EFFECT = ['Implementation', 'Closed']


def o_ratification(moc, approvals, today):
    """AS15 Q9. Only an Emergency change that is in effect needs
    ratification. Every level signed: Ratified. Otherwise the window is
    implementation date + 7 days: on or before its last day Awaiting,
    after it Overdue; no readable implementation date is Overdue."""
    moc = moc or {}
    if get(moc, 'type') != 'Emergency' or get(moc, 'stage') not in IN_EFFECT:
        return {'state': 'Not required', 'dueDate': None, 'outstanding': []}
    st = o_approval_state(approvals or [])
    if st['complete']:
        return {'state': 'Ratified', 'dueDate': None, 'outstanding': []}
    went = cal_date(get(moc, 'actual_implementation_date'))
    due = went + dt.timedelta(days=RATIFY_DAYS) if went else None
    left = (due - cal_date(today)).days if due else None
    return {
        'state': 'Ratification overdue' if left is None or left < 0 else 'Awaiting ratification',
        'dueDate': due.isoformat() if due else None,
        'outstanding': st['outstanding'],
    }


def o_can_assign_approver(moc, approver):
    """AS15 D1. Someone must be named, and not the change's originator."""
    if not js_truthy(approver):
        return {'ok': False}
    if approver == get(moc or {}, 'originator_id'):
        return {'ok': False}
    return {'ok': True}


def o_can_decide_approval(approval, moc, user):
    """AS15 D1. Only a pending approval, only by its assignee, never by the
    originator (even when the originator was assigned)."""
    approval = approval or {}
    status = get(approval, 'status')
    if js_truthy(status) and status != 'Pending':
        return {'ok': False}
    if not js_truthy(user) or user != get(approval, 'approver_id'):
        return {'ok': False}
    if user == get(moc or {}, 'originator_id'):
        return {'ok': False}
    return {'ok': True}


def o_summarise(records, ctx, today):
    ctx = ctx or {}
    # AS14 (Assurance STATUS 3l.4): an action on a closed, rejected or
    # cancelled change is locked with its change, so it is not open work.
    # An action whose change is not supplied still counts.
    finished = {get(m, 'id') for m in records if get(m, 'stage') in ('Closed', 'Rejected', 'Cancelled')} - {None}
    actions = [a for a in (ctx.get('actions') or []) if get(a, 'moc_id') not in finished]
    approvals = ctx.get('approvals') or []

    def rat_of(m):
        # An approval belongs to the change whose id it carries; a change
        # with no id has none.
        mid = get(m, 'id')
        mine = [] if mid is None else [a for a in approvals if get(a, 'moc_id') == mid]
        return o_ratification(m, mine, today)['state']

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
        'ratificationPending': sum(1 for m in records if rat_of(m) == 'Awaiting ratification'),
        'ratificationOverdue': sum(1 for m in records if rat_of(m) == 'Ratification overdue'),
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
# ASC-0 RC-3: the course's repro. A change implemented ON its target date
# is in effect and reads overdue from the next day under the old rule.
AS_OF = D('2026-10-01')
rc3 = {'stage': 'Implementation', 'type': 'Permanent', 'target_implementation_date': '2026-09-26',
       'actual_implementation_date': '2026-09-26'}
case('rc3-implemented-on-target', 'isOverdue', [rc3, AS_OF], o_is_overdue(rc3, AS_OF), 'RC-3')
rc3_temp = {'stage': 'Implementation', 'type': 'Temporary', 'expiry_date': '2026-12-31',
            'target_implementation_date': '2026-06-01'}
case('rc3-temporary-in-effect-long-past-target', 'isOverdue', [rc3_temp, AS_OF], o_is_overdue(rc3_temp, AS_OF), 'RC-3')
for stage in ('Draft', 'Screening', 'Review', 'Approval'):
    m = {'stage': stage, 'target_implementation_date': '2026-09-26'}
    case(f'rc3-pre-effect-{stage}-still-overdue', 'isOverdue', [m, AS_OF], o_is_overdue(m, AS_OF), 'RC-3')
rc3_records = [
    {'id': 'r1', 'stage': 'Implementation', 'type': 'Permanent', 'target_implementation_date': '2026-09-26'},
    {'id': 'r2', 'stage': 'Implementation', 'type': 'Temporary', 'expiry_date': '2027-01-01',
     'target_implementation_date': '2026-08-01'},
    {'id': 'r3', 'stage': 'Approval', 'type': 'Permanent', 'target_implementation_date': '2026-09-20'},
    {'id': 'r4', 'stage': 'Review', 'type': 'Permanent', 'target_implementation_date': '2026-10-20'},
]
rc3_actions = [
    {'moc_id': 'r1', 'action_type': 'Implementation', 'status': 'Open', 'due_date': '2026-09-28'},
    {'moc_id': 'r2', 'action_type': 'Post-implementation', 'status': 'Open', 'due_date': '2026-10-15'},
]
case('rc3-summarise-in-effect-not-overdue', 'summarise', [rc3_records, {'actions': rc3_actions}, AS_OF],
     o_summarise(rc3_records, {'actions': rc3_actions}, AS_OF), 'RC-3')

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
# AS14: actions on finished changes are not open work
as14_records = [
    {'id': 'live', 'stage': 'Implementation', 'type': 'Permanent'},
    {'id': 'rej', 'stage': 'Rejected', 'type': 'Permanent'},
    {'id': 'can', 'stage': 'Cancelled', 'type': 'Temporary', 'expiry_date': iso(-3)},
    {'id': 'clo', 'stage': 'Closed', 'type': 'Permanent'},
    {'id': 'dra', 'stage': 'Draft', 'type': 'Permanent'},
]
as14_actions = [
    {'moc_id': 'live', 'status': 'Open', 'due_date': iso(-1)},
    {'moc_id': 'rej', 'status': 'Open', 'due_date': iso(-40)},
    {'moc_id': 'can', 'status': 'In progress', 'due_date': iso(-2)},
    {'moc_id': 'clo', 'status': 'Open', 'due_date': iso(-9)},
    {'moc_id': 'dra', 'status': 'Open', 'due_date': iso(-5)},
    {'moc_id': 'not-loaded', 'status': 'Open', 'due_date': iso(-5)},
    {'status': 'Open', 'due_date': iso(-6)},
    {'moc_id': 'rej', 'status': 'Complete', 'due_date': iso(-40)},
]
case('summarise-actions-on-finished-changes', 'summarise', [as14_records, {'actions': as14_actions}, T],
     o_summarise(as14_records, {'actions': as14_actions}, T), 'MOC-AS14-1')
case('summarise-actions-parents-not-supplied', 'summarise', [[], {'actions': as14_actions}, T],
     o_summarise([], {'actions': as14_actions}, T))
case('summarise-unreadable-expiry', 'summarise', [[bad | {'stage': 'Implementation'}], {}, T],
     o_summarise([bad], {}, T), 'MOC-1')

# --- AS15 Q9: emergency-change authority (reduced up front, ratified within 7 days)
signed1 = [{'level': 1, 'status': 'Approved'}]
two_levels_first = [{'level': 1, 'status': 'Approved'}, {'level': 2, 'status': 'Pending'}]
two_levels_second = [{'level': 1, 'status': 'Pending'}, {'level': 2, 'status': 'Approved'}]
two_levels_rej = [{'level': 1, 'status': 'Approved'}, {'level': 2, 'status': 'Rejected'}]
levels_23 = [{'level': 2, 'status': 'Approved'}, {'level': 3, 'status': 'Pending'}]
levels_23_hi = [{'level': 2, 'status': 'Pending'}, {'level': 3, 'status': 'Approved'}]
em = {'type': 'Emergency', 'stage': 'Approval', 'expiry_date': iso(30)}
tmp = {'type': 'Temporary', 'stage': 'Approval', 'expiry_date': iso(30)}
perm = {'type': 'Permanent', 'stage': 'Approval'}
for tag, moc, appr in [
    ('emergency-first-level-only', em, two_levels_first),
    ('emergency-second-level-only', em, two_levels_second),
    ('emergency-rejected-later-level', em, two_levels_rej),
    ('emergency-levels-2-3-lowest-signed', em, levels_23),
    ('emergency-levels-2-3-highest-signed', em, levels_23_hi),
    ('emergency-no-approvers', em, []),
    ('emergency-all-signed', em, [{'level': 1, 'status': 'Approved'}, {'level': 2, 'status': 'Approved'}]),
    ('temporary-first-level-only', tmp, two_levels_first),
    ('permanent-first-level-only', perm, two_levels_first),
    ('emergency-first-level-only-no-expiry', {'type': 'Emergency', 'stage': 'Approval'}, two_levels_first),
]:
    case(f'advance-impl-{tag}', 'canAdvance', [moc, 'Implementation', {'approvals': appr}],
         o_can_advance(moc, 'Implementation', {'approvals': appr}), 'AS15-Q9')
em_in = {'type': 'Emergency', 'stage': 'Implementation', 'expiry_date': iso(30)}
for tag, appr in [('unratified', two_levels_first), ('ratified', [{'level': 1, 'status': 'Approved'}, {'level': 2, 'status': 'Approved'}]),
                  ('rejected-after', two_levels_rej)]:
    case(f'advance-close-emergency-{tag}', 'canAdvance', [em_in, 'Closed', {'approvals': appr}],
         o_can_advance(em_in, 'Closed', {'approvals': appr}), 'AS15-Q9')
case('advance-close-temporary-unratified-is-not-gated', 'canAdvance',
     [{'type': 'Temporary', 'stage': 'Implementation', 'expiry_date': iso(30)}, 'Closed', {'approvals': two_levels_first}],
     o_can_advance({'type': 'Temporary', 'stage': 'Implementation', 'expiry_date': iso(30)}, 'Closed', {'approvals': two_levels_first}))

def em_at(stage, went):
    m = {'type': 'Emergency', 'stage': stage, 'expiry_date': iso(30)}
    if went is not None:
        m['actual_implementation_date'] = went
    return m

for tag, moc, appr in [
    ('day-7-pending', em_at('Implementation', iso(-7) + 'T10:00:00'), two_levels_first),
    ('day-8-overdue', em_at('Implementation', iso(-8) + 'T10:00:00'), two_levels_first),
    ('same-day', em_at('Implementation', iso(0)), two_levels_first),
    ('no-implementation-date', em_at('Implementation', None), two_levels_first),
    ('unreadable-implementation-date', em_at('Implementation', 'last week'), two_levels_first),
    ('complete', em_at('Implementation', iso(-30)), [{'level': 1, 'status': 'Approved'}, {'level': 2, 'status': 'Approved'}]),
    ('closed-complete', em_at('Closed', iso(-30)), [{'level': 1, 'status': 'Approved'}]),
    ('rejected-after', em_at('Implementation', iso(-2)), two_levels_rej),
    ('no-approvals', em_at('Implementation', iso(-2)), []),
    ('levels-2-3', em_at('Implementation', iso(-3)), levels_23),
    ('still-in-approval', em_at('Approval', None), two_levels_first),
    ('cancelled', em_at('Cancelled', iso(-30)), two_levels_first),
    ('temporary', {'type': 'Temporary', 'stage': 'Implementation', 'expiry_date': iso(30),
                   'actual_implementation_date': iso(-30)}, two_levels_first),
    ('permanent', {'type': 'Permanent', 'stage': 'Implementation'}, []),
]:
    case(f'ratification-{tag}', 'ratificationState', [moc, appr, T], o_ratification(moc, appr, T), 'AS15-Q9')
case('ratification-no-args', 'ratificationState', [], o_ratification({}, [], T))

rat_records = [
    dict(em_at('Implementation', iso(-3)), id='p'),
    dict(em_at('Implementation', iso(-20)), id='o'),
    dict(em_at('Implementation', None), id='nodate'),
    dict(em_at('Closed', iso(-40)), id='done'),
    dict(em_at('Implementation', iso(-1))),  # no id: owns no approvals
    {'id': 'perm', 'type': 'Permanent', 'stage': 'Implementation'},
]
rat_appr = [
    {'moc_id': 'p', 'level': 1, 'status': 'Approved'}, {'moc_id': 'p', 'level': 2, 'status': 'Pending'},
    {'moc_id': 'o', 'level': 1, 'status': 'Approved'}, {'moc_id': 'o', 'level': 2, 'status': 'Pending'},
    {'moc_id': 'done', 'level': 1, 'status': 'Approved'},
    {'level': 1, 'status': 'Approved'},  # no moc_id: belongs to nobody
]
case('summarise-ratification', 'summarise', [rat_records, {'approvals': rat_appr}, T],
     o_summarise(rat_records, {'approvals': rat_appr}, T), 'AS15-Q9')

# --- AS15 D1: segregation of duties
orig = {'originator_id': 'u-orig'}
for tag, approver in [('independent', 'u-app'), ('originator', 'u-orig'), ('nobody', None), ('empty', '')]:
    case(f'assign-approver-{tag}', 'canAssignApprover', [orig, approver],
         o_can_assign_approver(orig, approver), 'AS15-D1')
case('assign-approver-no-originator-recorded', 'canAssignApprover', [{}, 'u-app'],
     o_can_assign_approver({}, 'u-app'))
pend = {'approver_id': 'u-app', 'status': 'Pending', 'level': 1}
for tag, appr, moc, user in [
    ('assignee', pend, orig, 'u-app'),
    ('non-assignee', pend, orig, 'u-other'),
    ('not-signed-in', pend, orig, None),
    ('originator-not-assigned', pend, orig, 'u-orig'),
    ('originator-who-is-assignee', dict(pend, approver_id='u-orig'), orig, 'u-orig'),
    ('already-approved', dict(pend, status='Approved'), orig, 'u-app'),
    ('already-rejected', dict(pend, status='Rejected'), orig, 'u-app'),
    ('no-status-is-pending', {'approver_id': 'u-app'}, orig, 'u-app'),
]:
    case(f'decide-approval-{tag}', 'canDecideApproval', [appr, moc, user],
         o_can_decide_approval(appr, moc, user), 'AS15-D1')

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
# ASC-0 RC-3: a change in Implementation past its target date ranks with
# live work, after the changes still late to be implemented.
sort_case('rc3-urgency-in-effect-ranks-as-live', [
    {'id': 'impl-past-target', 'stage': 'Implementation', 'type': 'Permanent',
     'target_implementation_date': iso(-30)},
    {'id': 'live-future', 'stage': 'Review', 'type': 'Permanent', 'target_implementation_date': iso(10)},
    {'id': 'approval-late', 'stage': 'Approval', 'type': 'Permanent', 'target_implementation_date': iso(-3)},
    {'id': 'closed', 'stage': 'Closed', 'type': 'Permanent', 'target_implementation_date': iso(-60)},
], T, 'RC-3')
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
