#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/qualityAssurance.js (AS12).

Written from the METHOD STATEMENTS, not from the JavaScript:
  - the module docstrings (a hold point stops work, a witness point does
    not; progress is counted from the checkpoints, null for a plan with no
    ITP; an NCR closes when its actions are done and, for Critical/Major,
    when a corrective action has been verified effective; a plan closes
    when its hold points are resolved, nothing failed and no NCR is open);
  - docs/scope/AssuranceApps-STATUS.md section 3f (AS7): a decision
    (Passed/Failed/Waived) is a date and a named verifier, a waiver also
    carries its reason, a "not effective" verdict is a real answer;
  - ISO 9001:2015 section 8.7 (control of nonconforming outputs: the
    disposition) and section 10.2 (corrective action: root cause, review the
    effectiveness of any corrective action taken); ITP hold/witness practice;
  - calendar.js: a 'YYYY-MM-DD' is a calendar date at local midnight, an
    unreadable date is no date. Python's datetime.date is the model.

Rules taken from the code rather than the docs are listed in
FINDINGS-quality.md. Stdlib only.
Run:  python3 tools/validation/assurance/oracle_quality.py
"""
import datetime as dt
import functools
import json
import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'assurance', 'goldens',
                   'qualityAssurance_cases.json')

# ---------------------------------------------------------------- values


def D(s):
    return {'$date': s}


UNDEF = {'$undefined': True}
INVALID_DATE = {'$date': None}


def js_truthy(v):
    if v is None or v is False:
        return False
    if isinstance(v, dict) and v.get('$undefined'):
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0
    if isinstance(v, str):
        return v != ''
    return True


def cal_date(v):
    if not js_truthy(v):
        return None
    if isinstance(v, dict) and '$date' in v:
        return None if v['$date'] is None else dt.date.fromisoformat(v['$date'])
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
    return None if d is None else (d - cal_date(today)).days


def out_date(d):
    return None if d is None else {'$date': d.isoformat()}


def get(o, k):
    if not isinstance(o, dict):
        return None
    v = o.get(k)
    if isinstance(v, dict) and v.get('$undefined'):
        return None
    return v


def blank(v):
    """No text: missing, empty, or only whitespace."""
    return not js_truthy(v) or (isinstance(v, str) and not v.strip())


def half_up(x):
    """A displayed whole percentage or whole day, rounding a half upwards."""
    return math.floor(x + 0.5)


# ---------------------------------------------------------------- vocabularies

PLAN_STATUSES = ['Draft', 'Under review', 'Active', 'Superseded', 'Closed', 'Cancelled']
PLAN_LIVE = ['Draft', 'Under review', 'Active']
PLAN_TERMINAL = ['Superseded', 'Closed', 'Cancelled']
POINT_TYPES = ['Hold point', 'Witness point', 'Review point', 'Monitor point', 'Surveillance point']
CP_STATUSES = ['Pending', 'Notified', 'In progress', 'Passed', 'Failed', 'Waived', 'Not applicable']
DECISIONS = ['Passed', 'Failed', 'Waived']
RESOLVED = ['Passed', 'Waived', 'Not applicable']
SEVERITIES = ['Critical', 'Major', 'Minor', 'Observation']
SERIOUS = ['Critical', 'Major']
NCR_STATUSES = ['Open', 'Under investigation', 'Disposition agreed', 'Actions in progress',
                'Verification', 'Closed', 'Voided']
NCR_OPEN = NCR_STATUSES[:5]
NCR_TERMINAL = ['Closed', 'Voided']
CONCESSIONS = ['Use as is', 'Regrade']
CAPA_STATUSES = ['Open', 'In progress', 'Complete', 'Cancelled']
CAPA_DONE = ['Complete', 'Cancelled']
BANDS = [('0 to 30 days', 0, 30), ('31 to 60 days', 31, 60), ('61 to 90 days', 61, 90),
         ('Over 90 days', 91, math.inf)]

# The plan workflow. The docs fix the terminal statuses and that a plan
# closes only from Active; the edges themselves are taken from the code
# (FINDINGS-quality.md, R1).
PLAN_EDGES = {
    'Draft': ['Under review', 'Active', 'Cancelled'],
    'Under review': ['Active', 'Draft', 'Cancelled'],
    'Active': ['Closed', 'Superseded', 'Cancelled'],
    'Superseded': [], 'Closed': [], 'Cancelled': [],
}

# ---------------------------------------------------------------- checkpoints


def o_is_blocking(cp):
    return get(cp or {}, 'point_type') == 'Hold point'


def o_is_resolved(cp):
    return get(cp or {}, 'status') in RESOLVED


def o_is_decided(cp):
    return get(cp or {}, 'status') in DECISIONS


def o_has_record(cp):
    cp = cp or {}
    named = js_truthy(get(cp, 'verified_by')) or not blank(get(cp, 'verifier_name'))
    return js_truthy(get(cp, 'result_date')) and named


def o_can_decide(cp, status, patch=None):
    if status not in CP_STATUSES:
        return {'ok': False}
    nxt = dict(cp or {})
    nxt.update(patch or {})
    nxt['status'] = status
    if status in DECISIONS and not o_has_record(nxt):
        return {'ok': False}
    if status == 'Waived' and blank(get(nxt, 'remarks')):
        return {'ok': False}
    # AS13-0: setting a HOLD point aside as not applicable carries the
    # same record as a waiver (date, who, why).
    if status == 'Not applicable' and get(nxt, 'point_type') == 'Hold point':
        if not o_has_record(nxt) or blank(get(nxt, 'remarks')):
            return {'ok': False}
    return {'ok': True}


def o_cp_overdue(cp, today):
    if o_is_resolved(cp):
        return False
    n = days_until(get(cp or {}, 'planned_date'), today)
    return n is not None and n < 0


def o_plan_progress(cps):
    total = len(cps)
    resolved = sum(1 for c in cps if o_is_resolved(c))
    holds = [c for c in cps if o_is_blocking(c)]
    return {
        'total': total,
        'resolved': resolved,
        'failed': sum(1 for c in cps if get(c, 'status') == 'Failed'),
        'outstanding': total - resolved,
        'holdPoints': len(holds),
        'holdPointsOutstanding': sum(1 for c in holds if not o_is_resolved(c)),
        # ASC-0 R2: half up on the EXACT rational, in integers. The float
        # form (resolved / total * 100) rounded 23 of 40 to 57 like the engine.
        'percent': None if total == 0 else (200 * resolved + total) // (2 * total),
    }

# ---------------------------------------------------------------- NCRs and CAPAs


def o_ncr_open(n):
    return get(n or {}, 'status') in NCR_OPEN


def o_ncr_overdue(n, today):
    if not o_ncr_open(n):
        return False
    d = days_until(get(n, 'due_date'), today)
    return d is not None and d < 0


def o_ncr_age(n, today):
    n = n or {}
    # Raised date, else the row's creation (rule from the code: the first
    # PRESENT value is used, R3).
    src = get(n, 'raised_date') if js_truthy(get(n, 'raised_date')) else get(n, 'created_at')
    raised = cal_date(src)
    if raised is None:
        return None
    end = cal_date(today)
    if not o_ncr_open(n):
        end = cal_date(get(n, 'closed_date')) or end
    return (end - raised).days


def o_age_band(days):
    if days is None or (isinstance(days, dict) and days.get('$undefined')):
        return None
    for label, lo, hi in BANDS:
        if lo <= days <= hi:
            return label
    return None


def o_capa_open(c):
    return get(c or {}, 'status') not in CAPA_DONE


def o_capa_overdue(c, today):
    if not o_capa_open(c):
        return False
    d = days_until(get(c, 'due_date'), today)
    return d is not None and d < 0


def o_eff_verified(c):
    c = c or {}
    return get(c, 'effectiveness_verified') is True \
        and js_truthy(get(c, 'effectiveness_checked_at')) \
        and js_truthy(get(c, 'effectiveness_verified_by'))


def o_eff_failed(c):
    return get(c or {}, 'effectiveness_verified') is False


def o_can_close_ncr(n, capas=None):
    n = n or {}
    capas = capas or []
    if get(n, 'status') in NCR_TERMINAL:
        return {'ok': False}
    if not js_truthy(get(n, 'disposition')) or not js_truthy(get(n, 'disposition_date')):
        return {'ok': False}
    serious = get(n, 'severity') in SERIOUS
    if serious and blank(get(n, 'root_cause')):
        return {'ok': False}
    if any(o_capa_open(c) for c in capas):
        return {'ok': False}
    if serious:
        corrective = [c for c in capas if get(c, 'action_type') == 'Corrective'
                      and get(c, 'status') != 'Cancelled']
        if not any(o_eff_verified(c) for c in corrective):
            return {'ok': False}
    return {'ok': True}

# ---------------------------------------------------------------- plans


def o_can_close_plan(plan, ctx=None):
    plan = plan or {}
    ctx = ctx or {}
    cps = ctx.get('checkpoints') or []
    ncrs = ctx.get('ncrs') or []
    if get(plan, 'status') in PLAN_TERMINAL:
        return {'ok': False}
    if any(get(c, 'status') == 'Failed' for c in cps):
        return {'ok': False}
    if any(o_is_blocking(c) and not o_is_resolved(c) for c in cps):
        return {'ok': False}
    if any(o_ncr_open(n) for n in ncrs):
        return {'ok': False}
    return {'ok': True}


def o_next_plan(status):
    return list(PLAN_EDGES.get(status, [])) if isinstance(status, str) else []


def o_can_advance_plan(plan, to, ctx=None):
    if to not in o_next_plan(get(plan or {}, 'status')):
        return {'ok': False}
    if to == 'Closed':
        return o_can_close_plan(plan, ctx)
    return {'ok': True}

# ---------------------------------------------------------------- summaries


def o_summarise(data, today):
    data = data or {}
    plans = data.get('plans') or []
    all_cps = data.get('checkpoints') or []
    ncrs = data.get('ncrs') or []
    all_capas = data.get('capas') or []
    # AS14 (Assurance STATUS 3l.4): outstanding means somebody can still do
    # it. A point on a finished plan, or an action on a withdrawn (voided)
    # NCR, is not outstanding work. History (totals, failures, the
    # effectiveness record) still counts it. An unknown parent counts.
    done_plans = {get(p, 'id') for p in plans if get(p, 'status') in PLAN_TERMINAL} - {None}
    voided = {get(n, 'id') for n in ncrs if get(n, 'status') == 'Voided'} - {None}
    cps = [c for c in all_cps if get(c, 'plan_id') not in done_plans]
    capas = [c for c in all_capas if get(c, 'ncr_id') not in voided]
    open_ncrs = [n for n in ncrs if o_ncr_open(n)]
    ages = [a for a in (o_ncr_age(n, today) for n in open_ncrs) if a is not None]
    return {
        'plans': len(plans),
        'activePlans': sum(1 for p in plans if get(p, 'status') == 'Active'),
        'livePlans': sum(1 for p in plans if get(p, 'status') in PLAN_LIVE),
        'byPlanStatus': {s: sum(1 for p in plans if get(p, 'status') == s) for s in PLAN_STATUSES},
        'checkpoints': len(all_cps),
        'checkpointsOutstanding': sum(1 for c in cps if not o_is_resolved(c)),
        'checkpointsOverdue': sum(1 for c in cps if o_cp_overdue(c, today)),
        'holdPointsOutstanding': sum(1 for c in cps if o_is_blocking(c) and not o_is_resolved(c)),
        'checkpointsFailed': sum(1 for c in all_cps if get(c, 'status') == 'Failed'),
        'ncrs': len(ncrs),
        'openNcrs': len(open_ncrs),
        'bySeverity': {s: sum(1 for n in ncrs if get(n, 'severity') == s) for s in SEVERITIES},
        'openBySeverity': {s: sum(1 for n in open_ncrs if get(n, 'severity') == s) for s in SEVERITIES},
        'ncrsOverdue': sum(1 for n in ncrs if o_ncr_overdue(n, today)),
        'seriousOpen': sum(1 for n in open_ncrs if get(n, 'severity') in SERIOUS),
        'concessions': sum(1 for n in ncrs if get(n, 'disposition') in CONCESSIONS),
        'oldestOpenNcrDays': max(ages) if ages else None,
        'meanOpenNcrAgeDays': half_up(sum(ages) / len(ages)) if ages else None,
        'capas': len(all_capas),
        'openCapas': sum(1 for c in capas if o_capa_open(c)),
        'overdueCapas': sum(1 for c in capas if o_capa_overdue(c, today)),
        'capasAwaitingEffectiveness': sum(
            1 for c in capas if get(c, 'status') == 'Complete'
            and get(c, 'effectiveness_verified') is None),
        'capasVerifiedEffective': sum(1 for c in all_capas if o_eff_verified(c)),
        'capasFoundIneffective': sum(1 for c in all_capas if o_eff_failed(c)),
    }


UNRECORDED = ['Pending', 'Notified', 'In progress']


def o_can_remove_checkpoint(cp, plan):
    """AS14. A finished plan keeps its points; a point with any result
    recorded is evidence; a hold point outside Draft is released (Not
    applicable, with who/when/why), never deleted."""
    if isinstance(plan, dict) and get(plan, 'status') in PLAN_TERMINAL:
        return {'ok': False}
    status = get(cp, 'status') or 'Pending'
    if status not in UNRECORDED or js_truthy(get(cp, 'result_date')):
        return {'ok': False}
    plan_status = get(plan, 'status') if isinstance(plan, dict) else None
    if o_is_blocking(cp) and plan_status != 'Draft':
        return {'ok': False}
    return {'ok': True}


def o_can_raise_ncr(plan):
    """AS14. No plan is fine; a finished plan cannot take a new NCR."""
    if not isinstance(plan, dict):
        return {'ok': True}
    if get(plan, 'status') in PLAN_TERMINAL:
        return {'ok': False}
    return {'ok': True}


def o_count_by(rows, field, unset='Unspecified'):
    seen, counts = [], {}
    for r in rows:
        v = r.get(field) if isinstance(r, dict) else None
        key = v if js_truthy(v) else unset
        k = json.dumps(key, sort_keys=True)
        if k not in counts:
            seen.append((k, key))
            counts[k] = 0
        counts[k] += 1
    return sorted(({'name': key, 'count': counts[k]} for k, key in seen), key=lambda x: -x['count'])


def o_ncr_ageing(ncrs, today):
    out = []
    for label, lo, hi in BANDS:
        row = {'name': label}
        for s in SEVERITIES:
            row[s] = sum(1 for n in ncrs if o_ncr_open(n) and get(n, 'severity') == s
                         and o_ncr_age(n, today) is not None and lo <= o_ncr_age(n, today) <= hi)
        out.append(row)
    return out


def urgency_order(rows, today):
    """Open serious and overdue first, then open serious, then open overdue,
    then open, then closed; within a rank the earliest due date (else the
    raised date) first, undated last."""
    def rank(n):
        if not o_ncr_open(n):
            return 4
        serious = get(n, 'severity') in SERIOUS
        late = o_ncr_overdue(n, today)
        return 0 if serious and late else 1 if serious else 2 if late else 3

    def key(n):
        d = get(n, 'due_date')
        return cal_date(d if js_truthy(d) else get(n, 'raised_date'))

    def cmp(a, b):
        if rank(a) != rank(b):
            return rank(a) - rank(b)
        da, db = key(a), key(b)
        if da and db:
            return (da - db).days
        return -1 if da else 1 if db else 0
    return [r['id'] for r in sorted(rows, key=functools.cmp_to_key(cmp))]

# ---------------------------------------------------------------- cases


cases = []


def case(cid, fn, args, expected, defect=None):
    c = {'id': cid, 'fn': fn, 'args': args, 'expected': expected}
    if defect:
        c['repaired'] = defect
    cases.append(c)


T = D('2026-09-18')
TODAY = dt.date(2026, 9, 18)


def iso(n):
    return (TODAY + dt.timedelta(days=n)).isoformat()


# --- calendar re-exports
for cid, v in [('parse-plain', '2026-09-18'), ('parse-timestamp', '2026-09-01T00:30:00+01:00'),
               ('parse-date', D('2026-12-31')), ('parse-null', None), ('parse-garbage', 'Sept 18'),
               ('parse-invalid-date', INVALID_DATE)]:
    case(cid, 'parseDateOnly', [v], out_date(cal_date(v)))
case('parse-31-april', 'parseDateOnly', ['2026-04-31'], None, 'CAL-1')
for cid, v, t in [('days-past', '2026-08-19', T), ('days-future', '2026-10-18', T),
                  ('days-null', None, T), ('days-dst-us-start', '2026-03-09', D('2026-03-07'))]:
    case(cid, 'daysUntil', [v, t], days_until(v, t))
for cid, v in [('tods-ts', '2026-09-18T23:59:59Z'), ('tods-null', ''), ('tods-date', D('2026-07-04'))]:
    d = cal_date(v)
    case(cid, 'toDateOnlyString', [v], None if d is None else d.isoformat())

# --- checkpoint predicates, every point type and every status
for pt in POINT_TYPES + [None]:
    case(f'blocking-{pt}', 'isBlockingPoint', [{'point_type': pt}], o_is_blocking({'point_type': pt}))
case('blocking-default', 'isBlockingPoint', [UNDEF], False)
for st in CP_STATUSES + ['Closed', None]:
    case(f'resolved-{st}', 'isResolved', [{'status': st}], o_is_resolved({'status': st}))
    case(f'decided-{st}', 'isDecided', [{'status': st}], o_is_decided({'status': st}))
case('resolved-default', 'isResolved', [UNDEF], False)
case('decided-default', 'isDecided', [UNDEF], False)

rec_cases = {
    'date-and-user': {'result_date': iso(0), 'verified_by': 'u-1'},
    'date-and-name': {'result_date': iso(0), 'verifier_name': 'DNV surveyor K. Obi'},
    'date-blank-name': {'result_date': iso(0), 'verifier_name': '   '},
    'no-date': {'verified_by': 'u-1', 'verifier_name': 'A'},
    'nothing': {},
    'date-null-user-and-name': {'result_date': iso(-1), 'verified_by': None, 'verifier_name': 'Lloyds'},
}
for tag, cp in rec_cases.items():
    case(f'record-{tag}', 'hasVerificationRecord', [cp], o_has_record(cp))

HP = {'id': 'c1', 'point_type': 'Hold point', 'status': 'Pending', 'item_no': '4.2'}
WP = {'id': 'c2', 'point_type': 'Witness point', 'status': 'Notified'}
signed = {'result_date': iso(0), 'verified_by': 'u-9'}
named = {'result_date': iso(0), 'verifier_name': 'Class surveyor'}
decide = [
    ('not-a-status', HP, 'Approved', {}),
    ('null-status', HP, None, {}),
    ('hold-pass-unsigned', HP, 'Passed', {}),
    ('hold-pass-date-only', HP, 'Passed', {'result_date': iso(0)}),
    ('hold-pass-name-only', HP, 'Passed', {'verifier_name': 'X'}),
    ('hold-pass-signed', HP, 'Passed', signed),
    ('hold-pass-named-external', HP, 'Passed', named),
    ('hold-fail-unsigned', HP, 'Failed', {}),
    ('hold-fail-signed', HP, 'Failed', signed),
    ('hold-waive-signed-no-reason', HP, 'Waived', signed),
    ('hold-waive-signed-blank-reason', HP, 'Waived', dict(signed, remarks='  ')),
    ('hold-waive-signed-with-reason', HP, 'Waived', dict(signed, remarks='Superseded by FAT at vendor')),
    ('hold-waive-reason-unsigned', HP, 'Waived', {'remarks': 'agreed'}),
    ('witness-pass-unsigned', WP, 'Passed', {}),
    ('witness-pass-signed', WP, 'Passed', named),
    ('hold-not-applicable', HP, 'Not applicable', {}),
    ('hold-na-signed-no-reason', HP, 'Not applicable', signed),
    ('hold-na-signed-with-reason', HP, 'Not applicable', dict(signed, remarks='Scope removed by MOC-2026-014')),
    ('hold-na-reason-unsigned', HP, 'Not applicable', {'remarks': 'not in scope'}),
    ('witness-not-applicable-bare', WP, 'Not applicable', {}),
    ('hold-back-to-pending', dict(HP, status='Failed'), 'Pending', {}),
    ('hold-notified', HP, 'Notified', {}),
    ('hold-in-progress', HP, 'In progress', {}),
    ('record-already-on-row', dict(HP, **signed), 'Passed', {}),
    ('patch-status-ignored', HP, 'Passed', {'status': 'Pending', **signed}),
]
for tag, cp, st, patch in decide:
    case(f'decide-{tag}', 'canDecideCheckpoint', [cp, st, patch], o_can_decide(cp, st, patch))
case('decide-no-patch', 'canDecideCheckpoint', [WP, 'Pending', UNDEF], o_can_decide(WP, 'Pending'))

for st in CP_STATUSES:
    for tag, off in [('yesterday', -1), ('today', 0)]:
        cp = {'status': st, 'planned_date': iso(off)}
        case(f'cp-overdue-{st}-{tag}', 'isCheckpointOverdue', [cp, T], o_cp_overdue(cp, T))
case('cp-overdue-no-date', 'isCheckpointOverdue', [{'status': 'Pending'}, T], False)
case('cp-overdue-garbage-date', 'isCheckpointOverdue', [{'status': 'Pending', 'planned_date': 'wk 38'}, T], False)

# --- planProgress
cp = lambda i, pt, st: {'id': i, 'point_type': pt, 'status': st}  # noqa: E731
progress_sets = {
    'no-itp': [],
    'one-of-eight': [cp('a', 'Witness point', 'Passed')] + [cp(f'b{i}', 'Review point', 'Pending') for i in range(7)],
    'three-of-eight': [cp(f'p{i}', 'Hold point', 'Passed') for i in range(3)]
                      + [cp(f'q{i}', 'Witness point', 'Pending') for i in range(5)],
    'two-of-three': [cp('a', 'Hold point', 'Passed'), cp('b', 'Hold point', 'Waived'), cp('c', 'Hold point', 'Failed')],
    'one-of-two-hundred': [cp('a', 'Monitor point', 'Not applicable')] + [cp(f'z{i}', 'Monitor point', 'Pending') for i in range(199)],
    'all-resolved': [cp('a', 'Surveillance point', 'Not applicable'), cp('b', 'Hold point', 'Passed')],
    'every-status': [cp(s, 'Hold point', s) for s in CP_STATUSES] + [cp('w' + s, 'Witness point', s) for s in CP_STATUSES],
    'five-of-eight': [cp(f'r{i}', 'Witness point', 'Passed') for i in range(5)] + [cp(f's{i}', 'Hold point', 'Pending') for i in range(3)],
}
for tag, rows in progress_sets.items():
    case(f'progress-{tag}', 'planProgress', [rows], o_plan_progress(rows))
case('progress-default', 'planProgress', [UNDEF], o_plan_progress([]))
# ASC-0 R2: exact halves. 23 of 40 is 57.5 exactly and prints 58; the float
# form printed 57. 57 of 200 is 28.5 -> 29 (float 28). 1 of 8 is 12.5 -> 13
# (float agreed). 29 of 200 is 14.5 -> 15 (float 14).
for tag, n, d in [('23-of-40', 23, 40), ('57-of-200', 57, 200), ('1-of-8', 1, 8), ('29-of-200', 29, 200)]:
    rows = ([cp(f'y{i}', 'Witness point', 'Passed') for i in range(n)]
            + [cp(f'n{i}', 'Monitor point', 'Pending') for i in range(d - n)])
    case(f'r2-progress-half-{tag}', 'planProgress', [rows], o_plan_progress(rows), 'R2')

# --- NCR predicates
for st in NCR_STATUSES + ['Draft', None]:
    case(f'ncr-open-{st}', 'isNcrOpen', [{'status': st}], o_ncr_open({'status': st}))
    n = {'status': st, 'due_date': iso(-1)}
    case(f'ncr-overdue-{st}', 'isNcrOverdue', [n, T], o_ncr_overdue(n, T))
case('ncr-overdue-due-today', 'isNcrOverdue', [{'status': 'Open', 'due_date': iso(0)}, T], False)
case('ncr-overdue-no-due', 'isNcrOverdue', [{'status': 'Open'}, T], False)
case('ncr-open-default', 'isNcrOpen', [UNDEF], False)

age_cases = {
    'open-raised-today': {'status': 'Open', 'raised_date': iso(0)},
    'open-30': {'status': 'Verification', 'raised_date': iso(-30)},
    'open-31': {'status': 'Open', 'raised_date': iso(-31)},
    'open-across-dst': {'status': 'Open', 'raised_date': '2026-03-01'},
    'open-created-at-only': {'status': 'Open', 'created_at': '2026-06-10T21:15:00Z'},
    'closed-with-date': {'status': 'Closed', 'raised_date': '2026-01-10', 'closed_date': '2026-03-15'},
    'closed-without-date': {'status': 'Closed', 'raised_date': iso(-12)},
    'voided-with-date': {'status': 'Voided', 'raised_date': '2025-12-25', 'closed_date': '2026-01-04'},
    'open-ignores-closed-date': {'status': 'Open', 'raised_date': iso(-5), 'closed_date': iso(-2)},
    'no-raised': {'status': 'Open'},
    'garbage-raised': {'status': 'Open', 'raised_date': 'last week'},
    'raised-date-object': {'status': 'Open', 'raised_date': D(iso(-400))},
}
for tag, n in age_cases.items():
    case(f'age-{tag}', 'ncrAgeDays', [n, T], o_ncr_age(n, T))
# Across the US spring-forward day the local-midnight gap is 23 hours short of whole days.
case('age-across-us-dst', 'ncrAgeDays', [{'status': 'Open', 'raised_date': '2026-03-07'}, D('2026-03-09')],
     o_ncr_age({'status': 'Open', 'raised_date': '2026-03-07'}, D('2026-03-09')))

for d in [0, 1, 30, 31, 60, 61, 90, 91, 3650, -1, None]:
    case(f'band-{d}', 'ageBand', [d], o_age_band(d))
case('band-undefined', 'ageBand', [UNDEF], None)

for st in CAPA_STATUSES + [None]:
    case(f'capa-open-{st}', 'isCapaOpen', [{'status': st}], o_capa_open({'status': st}))
    c = {'status': st, 'due_date': iso(-1)}
    case(f'capa-overdue-{st}', 'isCapaOverdue', [c, T], o_capa_overdue(c, T))
case('capa-overdue-today', 'isCapaOverdue', [{'status': 'Open', 'due_date': iso(0)}, T], False)

EFF = {'effectiveness_verified': True, 'effectiveness_checked_at': iso(-1), 'effectiveness_verified_by': 'u-3'}
eff_cases = {
    'true-full': EFF,
    'true-no-date': dict(EFF, effectiveness_checked_at=None),
    'true-no-verifier': dict(EFF, effectiveness_verified_by=None),
    'false-full': dict(EFF, effectiveness_verified=False),
    'null': dict(EFF, effectiveness_verified=None),
    'truthy-not-true': dict(EFF, effectiveness_verified='yes'),
    'missing': {},
}
for tag, c in eff_cases.items():
    case(f'eff-verified-{tag}', 'isEffectivenessVerified', [c], o_eff_verified(c))
    case(f'eff-failed-{tag}', 'isEffectivenessFailed', [c], o_eff_failed(c))

# --- canCloseNcr
base = {'status': 'Verification', 'disposition': 'Repair', 'disposition_date': iso(-3),
        'root_cause': 'Weld procedure not qualified for the wall thickness'}
done_eff = {'action_type': 'Corrective', 'status': 'Complete', **EFF}
done_uncheck = {'action_type': 'Corrective', 'status': 'Complete'}
done_fail = {'action_type': 'Corrective', 'status': 'Complete', 'effectiveness_verified': False,
             'effectiveness_checked_at': iso(-1), 'effectiveness_verified_by': 'u-3'}
prev_eff = {'action_type': 'Preventive', 'status': 'Complete', **EFF}
cancelled_eff = {'action_type': 'Corrective', 'status': 'Cancelled', **EFF}
close_ncr = []
for sev in SEVERITIES:
    close_ncr += [
        (f'{sev}-no-capas', dict(base, severity=sev), []),
        (f'{sev}-verified', dict(base, severity=sev), [done_eff]),
        (f'{sev}-completed-unchecked', dict(base, severity=sev), [done_uncheck]),
        (f'{sev}-found-ineffective', dict(base, severity=sev), [done_fail]),
        (f'{sev}-no-root-cause', dict(base, severity=sev, root_cause='  '), [done_eff]),
        (f'{sev}-open-capa', dict(base, severity=sev), [done_eff, {'action_type': 'Preventive', 'status': 'In progress'}]),
    ]
close_ncr += [
    ('major-ineffective-then-effective', dict(base, severity='Major'), [done_fail, done_eff]),
    ('major-only-preventive-verified', dict(base, severity='Major'), [prev_eff]),
    ('major-only-cancelled-corrective-verified', dict(base, severity='Major'), [cancelled_eff]),
    ('critical-verified-true-but-no-date', dict(base, severity='Critical'), [dict(done_eff, effectiveness_checked_at=None)]),
    ('major-capa-no-status', dict(base, severity='Major'), [done_eff, {'action_type': 'Corrective'}]),
    ('no-disposition', dict(base, severity='Minor', disposition=None), []),
    ('no-disposition-date', dict(base, severity='Observation', disposition_date=''), []),
    ('already-closed', dict(base, severity='Minor', status='Closed'), []),
    ('already-voided', dict(base, severity='Critical', status='Voided'), [done_eff]),
    ('from-open-status', dict(base, severity='Minor', status='Open', disposition='Use as is'), []),
    ('unknown-severity', dict(base, severity=None, root_cause=None), []),
]
for tag, n, capas in close_ncr:
    case(f'close-ncr-{tag}', 'canCloseNcr', [n, capas], o_can_close_ncr(n, capas))
case('close-ncr-no-capas-arg', 'canCloseNcr', [dict(base, severity='Minor'), UNDEF], o_can_close_ncr(dict(base, severity='Minor')))

# --- canClosePlan / canAdvancePlan
active = {'id': 'p1', 'status': 'Active'}
plan_ctx = {
    'empty': {},
    'hold-outstanding': {'checkpoints': [dict(HP), dict(WP, status='Passed')]},
    'hold-unnumbered-outstanding': {'checkpoints': [{'point_type': 'Hold point', 'status': 'In progress'}]},
    'witness-outstanding-only': {'checkpoints': [dict(HP, status='Passed'), dict(WP)]},
    'every-soft-type-pending': {'checkpoints': [cp(t, t, 'Pending') for t in POINT_TYPES[1:]]},
    'failed-witness': {'checkpoints': [dict(HP, status='Passed'), dict(WP, status='Failed')]},
    'hold-waived-and-na': {'checkpoints': [dict(HP, status='Waived'), dict(HP, id='c9', status='Not applicable')]},
    'open-minor-ncr': {'checkpoints': [dict(HP, status='Passed')], 'ncrs': [{'status': 'Open', 'severity': 'Minor'}]},
    'open-observation-ncr': {'ncrs': [{'status': 'Verification', 'severity': 'Observation'}]},
    'closed-and-voided-ncrs': {'ncrs': [{'status': 'Closed', 'severity': 'Critical'}, {'status': 'Voided', 'severity': 'Major'}]},
}
for tag, ctx in plan_ctx.items():
    case(f'close-plan-{tag}', 'canClosePlan', [active, ctx], o_can_close_plan(active, ctx))
    case(f'advance-plan-close-{tag}', 'canAdvancePlan', [active, 'Closed', ctx], o_can_advance_plan(active, 'Closed', ctx))
for st in PLAN_TERMINAL:
    case(f'close-plan-already-{st}', 'canClosePlan', [{'status': st}, {}], o_can_close_plan({'status': st}))
case('close-plan-no-context', 'canClosePlan', [active, UNDEF], o_can_close_plan(active))
for st in PLAN_STATUSES + ['Open', None]:
    case(f'next-plan-{st}', 'nextPlanStatuses', [st], o_next_plan(st))
    for to in PLAN_STATUSES:
        args = [{'status': st}, to, plan_ctx['hold-outstanding']]
        case(f'advance-plan-{st}-to-{to}', 'canAdvancePlan', args,
             o_can_advance_plan({'status': st}, to, plan_ctx['hold-outstanding']))
case('advance-plan-no-context', 'canAdvancePlan', [active, 'Closed', UNDEF], o_can_advance_plan(active, 'Closed'))

# --- summarise
plans = [{'status': s} for s in PLAN_STATUSES] + [{'status': 'Active'}, {'status': 'Archived'}, {}]
cps = [
    dict(cp('h1', 'Hold point', 'Pending'), planned_date=iso(-1)),
    dict(cp('h2', 'Hold point', 'Failed'), planned_date=iso(-9)),
    dict(cp('h3', 'Hold point', 'Passed'), planned_date=iso(-9)),
    dict(cp('h4', 'Hold point', 'Notified'), planned_date=iso(0)),
    dict(cp('w1', 'Witness point', 'Pending'), planned_date=iso(-3)),
    dict(cp('w2', 'Witness point', 'Waived'), planned_date=iso(-3)),
    dict(cp('w3', 'Review point', 'Not applicable')),
    dict(cp('w4', 'Monitor point', 'In progress'), planned_date='TBA'),
    dict(cp('w5', 'Surveillance point', 'Failed')),
]
ncrs = [
    {'status': 'Open', 'severity': 'Critical', 'raised_date': iso(-95), 'due_date': iso(-1), 'disposition': 'Repair'},
    {'status': 'Under investigation', 'severity': 'Major', 'raised_date': iso(-31), 'due_date': iso(0)},
    {'status': 'Disposition agreed', 'severity': 'Minor', 'raised_date': iso(-60), 'due_date': iso(-30), 'disposition': 'Use as is'},
    {'status': 'Actions in progress', 'severity': 'Observation', 'raised_date': iso(-61)},
    {'status': 'Verification', 'severity': 'Major', 'created_at': iso(-2) + 'T08:00:00Z'},
    {'status': 'Open', 'severity': 'Minor'},
    {'status': 'Closed', 'severity': 'Critical', 'raised_date': iso(-400), 'closed_date': iso(-300), 'due_date': iso(-350), 'disposition': 'Regrade'},
    {'status': 'Voided', 'severity': 'Major', 'raised_date': iso(-200), 'due_date': iso(-100), 'disposition': 'Scrap'},
    {'status': 'Open', 'severity': 'Unrated', 'raised_date': iso(-10)},
]
capas = [
    {'status': 'Open', 'due_date': iso(-1)},
    {'status': 'In progress', 'due_date': iso(0)},
    {'status': 'Complete', 'due_date': iso(-50)},
    dict(EFF, status='Complete'),
    dict(EFF, status='Complete', effectiveness_verified=False),
    dict(EFF, status='Complete', effectiveness_verified_by=None),
    {'status': 'Cancelled', 'due_date': iso(-50)},
    {'due_date': iso(-5)},
    {'status': 'Complete', 'effectiveness_verified': None},
]
full = {'plans': plans, 'checkpoints': cps, 'ncrs': ncrs, 'capas': capas}
case('summarise-full', 'summarise', [full, T], o_summarise(full, T))
case('summarise-empty', 'summarise', [{}, T], o_summarise({}, T))
case('summarise-default', 'summarise', [UNDEF, T], o_summarise({}, T))
case('summarise-a-month-later', 'summarise', [full, D(iso(31))], o_summarise(full, D(iso(31))))
# Mean age rounding at a half: ages 1 and 2 -> 1.5 -> 2
half = {'ncrs': [{'status': 'Open', 'severity': 'Minor', 'raised_date': iso(-1)},
                 {'status': 'Open', 'severity': 'Minor', 'raised_date': iso(-2)}]}
case('summarise-mean-half', 'summarise', [half, T], o_summarise(half, T))
closed_only = {'ncrs': [ncrs[6], ncrs[7]], 'capas': capas[6:7]}
case('summarise-only-closed', 'summarise', [closed_only, T], o_summarise(closed_only, T))

# --- AS14: outstanding work excludes children of finished parents
as14 = {
    'plans': [{'id': 'p-active', 'status': 'Active'}, {'id': 'p-closed', 'status': 'Closed'},
              {'id': 'p-sup', 'status': 'Superseded'}, {'id': 'p-cancel', 'status': 'Cancelled'},
              {'id': 'p-draft', 'status': 'Draft'}],
    'checkpoints': [
        dict(cp('a1', 'Hold point', 'Pending'), plan_id='p-active', planned_date=iso(-2)),
        dict(cp('a2', 'Witness point', 'Failed'), plan_id='p-active'),
        dict(cp('c1', 'Hold point', 'Pending'), plan_id='p-closed', planned_date=iso(-20)),
        dict(cp('c2', 'Witness point', 'Failed'), plan_id='p-closed'),
        dict(cp('s1', 'Review point', 'In progress'), plan_id='p-sup', planned_date=iso(-1)),
        dict(cp('x1', 'Hold point', 'Notified'), plan_id='p-cancel', planned_date=iso(-3)),
        dict(cp('d1', 'Hold point', 'Pending'), plan_id='p-draft'),
        dict(cp('o1', 'Hold point', 'Pending'), plan_id='p-not-loaded', planned_date=iso(-4)),
        dict(cp('n1', 'Monitor point', 'Pending'), planned_date=iso(-4)),
    ],
    'ncrs': [{'id': 'n-open', 'status': 'Open', 'severity': 'Major', 'raised_date': iso(-5)},
             {'id': 'n-void', 'status': 'Voided', 'severity': 'Critical', 'raised_date': iso(-50)},
             {'id': 'n-closed', 'status': 'Closed', 'severity': 'Minor', 'raised_date': iso(-50)}],
    'capas': [
        {'ncr_id': 'n-open', 'status': 'Open', 'due_date': iso(-1)},
        {'ncr_id': 'n-void', 'status': 'Open', 'due_date': iso(-30)},
        {'ncr_id': 'n-void', 'status': 'In progress', 'due_date': iso(-2)},
        {'ncr_id': 'n-void', 'status': 'Complete'},
        dict(EFF, ncr_id='n-void', status='Complete', effectiveness_verified=False),
        {'ncr_id': 'n-closed', 'status': 'Complete'},
        {'ncr_id': 'n-unknown', 'status': 'Open', 'due_date': iso(-9)},
        {'status': 'Open', 'due_date': iso(-9)},
    ],
}
case('summarise-children-of-finished-parents', 'summarise', [as14, T], o_summarise(as14, T), 'QA-AS14-1')
case('summarise-unknown-parents-still-count', 'summarise',
     [{'checkpoints': as14['checkpoints'], 'capas': as14['capas']}, T],
     o_summarise({'checkpoints': as14['checkpoints'], 'capas': as14['capas']}, T))

# --- AS14: removing an inspection point, raising an NCR against a plan
for st in PLAN_STATUSES + ['Archived']:
    for cst in CP_STATUSES:
        for pt in ['Hold point', 'Witness point']:
            one = cp('r', pt, cst)
            case(f'remove-{st}-{pt.split()[0].lower()}-{cst}', 'canRemoveCheckpoint',
                 [one, {'status': st, 'plan_code': 'QAP-1'}],
                 o_can_remove_checkpoint(one, {'status': st}), 'QA-AS14-2')
pend_dated = dict(cp('r', 'Witness point', 'Pending'), result_date=iso(-1))
case('remove-pending-with-result-date', 'canRemoveCheckpoint', [pend_dated, {'status': 'Active'}],
     o_can_remove_checkpoint(pend_dated, {'status': 'Active'}), 'QA-AS14-2')
no_status = {'item_no': '7', 'point_type': 'Witness point'}
case('remove-no-status-is-pending', 'canRemoveCheckpoint', [no_status, {'status': 'Active'}],
     o_can_remove_checkpoint(no_status, {'status': 'Active'}))
hold = cp('r', 'Hold point', 'Pending')
case('remove-hold-plan-unknown', 'canRemoveCheckpoint', [hold, None], o_can_remove_checkpoint(hold, None))
case('remove-hold-no-plan-arg', 'canRemoveCheckpoint', [hold], o_can_remove_checkpoint(hold, None))
witness = cp('r', 'Witness point', 'Pending')
case('remove-witness-plan-unknown', 'canRemoveCheckpoint', [witness, None],
     o_can_remove_checkpoint(witness, None))
for st in PLAN_STATUSES + ['Archived']:
    case(f'raise-ncr-plan-{st}', 'canRaiseNcr', [{'status': st, 'plan_code': 'QAP-9'}],
         o_can_raise_ncr({'status': st}), 'QA-AS14-3')
case('raise-ncr-no-plan', 'canRaiseNcr', [None], o_can_raise_ncr(None))
case('raise-ncr-undefined-plan', 'canRaiseNcr', [UNDEF], o_can_raise_ncr(None))

# --- countBy
rows = [{'root_cause_category': 'Design'}, {'root_cause_category': 'Communication'}, {},
        {'root_cause_category': 'Design'}, {'root_cause_category': ''}, {'root_cause_category': 'Other'}]
case('countBy-root-cause', 'countBy', [rows, 'root_cause_category'], o_count_by(rows, 'root_cause_category'))
case('countBy-unset-label', 'countBy', [rows, 'root_cause_category', 'Not analysed'],
     o_count_by(rows, 'root_cause_category', 'Not analysed'))
case('countBy-empty', 'countBy', [[], 'severity'], [])

# --- ncrAgeing
case('ageing-register', 'ncrAgeing', [ncrs, T], o_ncr_ageing(ncrs, T))
case('ageing-empty', 'ncrAgeing', [[], T], o_ncr_ageing([], T))
edges = [{'status': 'Open', 'severity': s, 'raised_date': iso(-d)}
         for s, d in [('Critical', 30), ('Critical', 31), ('Major', 60), ('Major', 61), ('Minor', 90),
                      ('Minor', 91), ('Observation', 0)]] + [
    {'status': 'Open', 'severity': 'Major', 'raised_date': iso(3)},
    {'status': 'Closed', 'severity': 'Critical', 'raised_date': iso(-5)}]
case('ageing-band-edges', 'ncrAgeing', [edges, T], o_ncr_ageing(edges, T))

# --- ncrByUrgency
urg = [
    {'id': 'closed', 'status': 'Closed', 'severity': 'Critical', 'due_date': iso(-100)},
    {'id': 'minor-open-later', 'status': 'Open', 'severity': 'Minor', 'due_date': iso(20)},
    {'id': 'minor-overdue', 'status': 'Open', 'severity': 'Minor', 'due_date': iso(-2)},
    {'id': 'major-open', 'status': 'Verification', 'severity': 'Major', 'due_date': iso(5)},
    {'id': 'critical-overdue-b', 'status': 'Open', 'severity': 'Critical', 'due_date': iso(-1)},
    {'id': 'major-overdue-a', 'status': 'Actions in progress', 'severity': 'Major', 'due_date': iso(-40)},
    {'id': 'observation-undated', 'status': 'Open', 'severity': 'Observation'},
    {'id': 'minor-open-raised-only', 'status': 'Open', 'severity': 'Minor', 'raised_date': iso(-3)},
    {'id': 'voided', 'status': 'Voided', 'severity': 'Major'},
    {'id': 'critical-due-today', 'status': 'Open', 'severity': 'Critical', 'due_date': iso(0)},
]
for cid, rows in [('ncr-urgency-register', urg), ('ncr-urgency-empty', [])]:
    cases.append({'id': cid, 'sort': 'ncrByUrgency', 'factory': True, 'factoryArgs': [T],
                  'rows': rows, 'expectedOrder': urgency_order(rows, T)})

golden = {
    'module': 'qualityAssurance',
    'generatedBy': 'tools/validation/assurance/oracle_quality.py',
    'description': 'Independent stdlib-Python oracle for the QA plan and NCR rules: hold point versus '
                   'witness point, checkpoint decisions needing a date and a named verifier (and a '
                   'reason for a waiver), progress counted from checkpoints (null with no ITP), NCR '
                   'closure on disposition, root cause and verified-effective corrective action for '
                   'Critical/Major only, plan closure, NCR ageing bands, the dashboard summary and the '
                   'NCR urgency sort. Findings: FINDINGS-quality.md.',
    'cases': cases,
}

if __name__ == '__main__':
    with open(OUT, 'w') as f:
        json.dump(golden, f, indent=1)
        f.write('\n')
    print(f'{len(cases)} cases -> {os.path.normpath(OUT)}')
