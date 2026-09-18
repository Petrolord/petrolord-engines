#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/auditManagement.js (AS10, Audit &
Findings Manager).

Stdlib-only Python 3, written from the METHOD STATEMENTS: the module
docstrings, docs/scope/AssuranceApps-STATUS.md section 3i (AS10), and
migration 20260917800000_as10_audit_findings_manager.sql (whose header
states the five rules and whose check constraints and triggers are the
database's half of them). Only signatures, field names and vocabularies
were read from the JS.

A finding is a finding: the engine deliberately imports AS8's finding and
action rules, so this oracle deliberately imports the same rules from
oracle_iso.py rather than restating them. Every re-exported function still
gets its own case here, to show the re-export IS the same rule.

Usage:  python3 tools/validation/assurance/oracle_audit.py
Writes: test-data/assurance/goldens/auditManagement_cases.json
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import oracle_iso as iso  # noqa: E402
from oracle_iso import (  # noqa: E402
    Cases, D, INVALID, MAJOR, MINOR, FINDING_TYPES, VERIFIED, allow, refuse, present, written,
    days_until, parse_date, ymd, date, finding_open, finding_overdue, finding_age,
    can_close_finding, action_open, action_overdue, verified_effective, found_ineffective,
    nonconformity, count_by, urgency_order, iso_rank, tally,
)

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'test-data' / 'assurance' / 'goldens' / 'auditManagement_cases.json'

AUDIT_STATUSES = ['Planned', 'In progress', 'Fieldwork complete', 'Reported', 'Closed',
                  'Cancelled']
FINAL = ['Closed', 'Cancelled']
DELIVERED = ['Reported', 'Closed']          # the audit happened and said something
DONE = DELIVERED + ['Cancelled']            # nothing left to do for the programme
ANSWERS = ['Conformant', 'Nonconformant', 'Observation', 'Not applicable']

TRANSITIONS = {
    'Planned': ['In progress', 'Cancelled'],
    'In progress': ['Fieldwork complete', 'Cancelled'],
    'Fieldwork complete': ['Reported', 'In progress', 'Cancelled'],
    'Reported': ['Closed'],
    'Closed': [],
    'Cancelled': [],
}
PROGRAMME_TRANSITIONS = {
    'Draft': ['Approved', 'Cancelled'],
    'Approved': ['In progress', 'Cancelled'],
    'In progress': ['Complete', 'Cancelled'],
    'Complete': [],
    'Cancelled': [],
}


def half_up_percent(num, den):
    """Nearest whole percent, halves up, computed exactly."""
    return (200 * num + den) // (2 * den)


# ---------------------------------------------------------------------------
# Checklist execution
# ---------------------------------------------------------------------------

def answered(r):
    # An answer is one of the four results; "Not applicable" IS an answer,
    # and an answer has a reason. AS15-Q11 (owner decision): the rule is
    # checked here too rather than trusted to the form and the
    # audit_responses_na_needs_reason constraint, so a N/A with no written
    # reason (blank or whitespace) is not an answer, however it was stored.
    r = r or {}
    if r.get('result') not in ANSWERS:
        return False
    if r.get('result') == 'Not applicable':
        note = r.get('note')
        return isinstance(note, str) and note.strip() != ''
    return True


def _by_item(responses):
    out = {}
    for r in responses:
        out[r.get('item_id')] = r  # one response per item (unique key)
    return out


def checklist_progress(items=None, responses=None):
    items = items or []
    responses = responses or []
    by = _by_item(responses)
    res = [by.get(i.get('id'), {}).get('result') for i in items]
    total = len(items)
    n_ans = sum(1 for i in items if answered(by.get(i.get('id'))))  # AS15-Q11: via answered()
    return {
        'total': total,
        'answered': n_ans,
        'outstanding': total - n_ans,
        'conformant': res.count('Conformant'),
        'nonconformant': res.count('Nonconformant'),
        'observations': res.count('Observation'),
        'notApplicable': res.count('Not applicable'),
        'percent': None if total == 0 else half_up_percent(n_ans, total),
    }


def unanswered_items(items=None, responses=None):
    items = items or []
    by = _by_item(responses or [])
    return [i for i in items if not answered(by.get(i.get('id')))]


def critical_without_findings(items=None, responses=None, findings=None):
    items = items or []
    item_by = {i.get('id'): i for i in items}
    raised = {f.get('response_id') for f in (findings or [])
              if f.get('status') != 'Voided' and present(f.get('response_id'))}
    out = []
    for r in responses or []:
        it = item_by.get(r.get('item_id'))
        if (r.get('result') == 'Nonconformant' and it is not None
                and it.get('criticality') == 'Critical' and r.get('id') not in raised):
            out.append(it)
    return out


# ---------------------------------------------------------------------------
# Independence, lifecycle, programme
# ---------------------------------------------------------------------------

def audit_independence(audit):
    lead, auditee = audit.get('lead_auditor_id'), audit.get('auditee_id')
    if present(lead) and present(auditee) and lead == auditee:
        return refuse()
    return allow()


def lead_named(a):
    return present(a.get('lead_auditor_id')) or written(a.get('lead_auditor_name'))


def can_report_audit(audit, ctx=None):
    ctx = ctx or {}
    items, responses, findings = ctx.get('items', []), ctx.get('responses', []), \
        ctx.get('findings', [])
    if audit.get('status') in FINAL:
        return refuse()
    # an ad-hoc audit with no protocol has no checklist to leave blank
    if present(audit.get('template_id')) and unanswered_items(items, responses):
        return refuse()
    if critical_without_findings(items, responses, findings):
        return refuse()
    if not written(audit.get('conclusion')):
        return refuse()
    if not lead_named(audit):
        return refuse()
    return allow()


def can_close_audit(audit, findings=None):
    findings = findings or []
    if audit.get('status') in FINAL or audit.get('status') != 'Reported':
        return refuse()
    if any(finding_open(f) and f.get('finding_type') == MAJOR for f in findings):
        return refuse()
    if any(finding_open(f) and f.get('stop_work') for f in findings):
        return refuse()
    return allow()


def can_cancel_audit(audit, patch=None):
    patch = patch or {}
    if audit.get('status') in FINAL:
        return refuse()
    # a value in the patch (even a blank one) is what will be written
    reason = patch['cancellation_reason'] if patch.get('cancellation_reason') is not None \
        else audit.get('cancellation_reason')
    if not written(reason):
        return refuse()
    return allow()


def next_statuses(table, s):
    return list(table.get(s, [])) if isinstance(s, str) else []


def can_advance_audit(audit, to, ctx=None):
    ctx = ctx or {}
    if to not in next_statuses(TRANSITIONS, audit.get('status')):
        return refuse()
    if to == 'Reported':
        return can_report_audit(audit, ctx)
    if to == 'Closed':
        return can_close_audit(audit, ctx.get('findings', []))
    if to == 'Cancelled':
        return can_cancel_audit(audit, ctx.get('patch'))
    return allow()


def audit_overdue(a, today):
    """Not yet reported (or ended) and past its planned end."""
    if a.get('status') in DONE:
        return False
    n = days_until(a.get('planned_end'), today)
    return n is not None and n < 0


def audit_outstanding(a):
    """ASC-0 R1, under AS15-Q11: an audit is outstanding until it is
    reported, closed, or cancelled with a written reason. One rule for the
    programme's progress and the dashboard's summary alike."""
    if a.get('status') not in DONE:
        return True
    reason = a.get('cancellation_reason')
    return a.get('status') == 'Cancelled' and not (isinstance(reason, str) and reason.strip())


def programme_progress(audits=None, today=None):
    audits = audits or []
    total = len(audits)
    reported = sum(1 for a in audits if a.get('status') in DELIVERED)
    outstanding = [a for a in audits if audit_outstanding(a)]
    return {
        'total': total,
        'reported': reported,
        'cancelled': sum(1 for a in audits if a.get('status') == 'Cancelled'),
        'outstanding': len(outstanding),
        'overdue': sum(1 for a in outstanding if audit_overdue(a, today)),
        'percent': None if total == 0 else half_up_percent(reported, total),
    }


def can_approve_programme(p, patch=None):
    nxt = dict(p)
    nxt.update(patch or {})
    if not present(nxt.get('approved_at')):
        return refuse()
    if not (present(nxt.get('approved_by')) or written(nxt.get('approver_name'))):
        return refuse()
    return allow()


def can_complete_programme(p, audits=None):
    if p.get('status') in ('Complete', 'Cancelled'):
        return refuse()
    for a in audits or []:
        if a.get('status') not in DONE:
            return refuse()
        # AS15-Q11: a cancellation is "done" only with its written reason.
        reason = a.get('cancellation_reason')
        if a.get('status') == 'Cancelled' and not (isinstance(reason, str) and reason.strip()):
            return refuse()
    return allow()


def can_advance_programme(p, to, ctx=None):
    ctx = ctx or {}
    if to not in next_statuses(PROGRAMME_TRANSITIONS, p.get('status')):
        return refuse()
    if to == 'Approved':
        return can_approve_programme(p, ctx.get('patch'))
    if to == 'Complete':
        return can_complete_programme(p, ctx.get('audits', []))
    return allow()


def can_raise_finding(f):
    if f.get('finding_type') not in FINDING_TYPES:
        return refuse()
    if not written(f.get('title')) or not written(f.get('objective_evidence')):
        return refuse()
    if f.get('stop_work'):
        if not nonconformity(f) or not written(f.get('correction')):
            return refuse()
    return allow()


def summarise(data=None, today=None):
    data = data or {}
    progs = data.get('programmes', [])
    temps = data.get('templates', [])
    audits = data.get('audits', [])
    resp = data.get('responses', [])
    finds = data.get('findings', [])
    acts = data.get('actions', [])
    open_by = tally(finds, 'finding_type', FINDING_TYPES, finding_open)
    return {
        'programmes': len(progs),
        'activeProgrammes': sum(1 for p in progs if p.get('status') in ('Approved', 'In progress')),
        'templates': len(temps),
        'activeTemplates': sum(1 for t in temps if t.get('status') == 'Active'),
        'audits': len(audits),
        'byAuditStatus': tally(audits, 'status', AUDIT_STATUSES),
        'auditsOutstanding': sum(1 for a in audits if audit_outstanding(a)),
        'auditsOverdue': sum(1 for a in audits if audit_overdue(a, today)),
        'auditsReported': sum(1 for a in audits if a.get('status') in DELIVERED),
        'auditsCancelled': sum(1 for a in audits if a.get('status') == 'Cancelled'),
        'answers': sum(1 for r in resp if answered(r)),
        'answersOutstanding': sum(1 for r in resp if not answered(r)),
        'nonconformances': sum(1 for r in resp if r.get('result') == 'Nonconformant'),
        'notApplicable': sum(1 for r in resp if r.get('result') == 'Not applicable'),
        'findings': len(finds),
        'openFindings': sum(1 for f in finds if finding_open(f)),
        'byFindingType': tally(finds, 'finding_type', FINDING_TYPES),
        'openByFindingType': open_by,
        'openMajor': open_by[MAJOR],
        'stopWork': sum(1 for f in finds if f.get('stop_work')),
        'stopWorkOpen': sum(1 for f in finds if f.get('stop_work') and finding_open(f)),
        'findingsOverdue': sum(1 for f in finds if finding_overdue(f, today)),
        'actions': len(acts),
        'openActions': sum(1 for a in acts if action_open(a)),
        'overdueActions': sum(1 for a in acts if action_overdue(a, today)),
        'actionsAwaitingEffectiveness': sum(
            1 for a in acts if a.get('status') == 'Complete'
            and a.get('effectiveness_verified') not in (True, False)),
        'actionsVerifiedEffective': sum(1 for a in acts if verified_effective(a)),
        'actionsFoundIneffective': sum(1 for a in acts if found_ineffective(a)),
    }


def attention_rank(f, today):
    if finding_open(f) and f.get('stop_work'):
        return 0
    if finding_open(f) and f.get('finding_type') == MAJOR:
        return 1 if finding_overdue(f, today) else 2
    if finding_open(f) and finding_overdue(f, today):
        return 3
    if finding_open(f):
        return 4
    return 5


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

T = date('2026-09-17')


def it(**o):
    x = {'id': 'i1', 'template_id': 't1', 'item_no': '1.1', 'criticality': 'Critical'}
    x.update(o)
    return x


def rs(**o):
    x = {'id': 'r1', 'audit_id': 'a1', 'item_id': 'i1', 'result': 'Conformant',
         'examined_on': '2026-09-02'}
    x.update(o)
    return x


def au(**o):
    x = {'id': 'a1', 'audit_code': 'AUD-2026-001', 'template_id': 't1', 'audit_type': 'Contractor',
         'status': 'Fieldwork complete', 'lead_auditor_id': 'u1', 'auditee_id': 'u2',
         'conclusion': 'One nonconformity, closed on site.', 'planned_start': '2026-09-01',
         'planned_end': '2026-09-05'}
    x.update(o)
    return x


def fi(**o):
    x = {'id': 'f1', 'finding_code': 'AF-2026-001', 'audit_id': 'a1', 'finding_type': MAJOR,
         'title': 'Work without a displayed permit', 'objective_evidence': 'No permit at 09:40.',
         'status': 'Open', 'raised_date': '2026-09-02', 'stop_work': False}
    x.update(o)
    return x


def ac(**o):
    x = {'id': 'x1', 'finding_id': 'f1', 'action_type': 'Corrective', 'status': 'Open'}
    x.update(o)
    return x


def pg(**o):
    x = {'id': 'p1', 'title': '2026 HSE audit programme', 'programme_year': 2026,
         'status': 'In progress', 'approved_at': '2026-01-10', 'approved_by': 'u9'}
    x.update(o)
    return x


def build():
    c = Cases()

    # --- re-exports: the same rules as AS8 / AS7 / calendar ----------------
    c.add('reexport-parse', 'parseDateOnly', ['2026-09-17T06:00:00Z'], date('2026-09-17'))
    c.add('reexport-parse-invalid', 'parseDateOnly', [INVALID], None)
    c.add('reexport-parse-feb-30', 'parseDateOnly', ['2026-02-30'], parse_date('2026-02-30'),
          defect='CAL-1')
    c.add('reexport-days', 'daysUntil', ['2026-09-10', T], days_until('2026-09-10', T))
    c.add('reexport-days-none', 'daysUntil', [None, T], None)
    c.add('reexport-ymd', 'toDateOnlyString', [date('2026-01-31')], ymd(date('2026-01-31')))
    c.add('reexport-action-open', 'isActionOpen', [ac(status='In progress')], True)
    c.add('reexport-action-closed', 'isActionOpen', [ac(status='Cancelled')], False)
    c.add('reexport-action-overdue', 'isActionOverdue', [ac(due_date='2026-09-16'), T],
          action_overdue(ac(due_date='2026-09-16'), T))
    c.add('reexport-action-due-today', 'isActionOverdue', [ac(due_date='2026-09-17'), T], False)
    c.add('reexport-eff-verified', 'isEffectivenessVerified', [ac(**VERIFIED)], True)
    c.add('reexport-eff-unsigned', 'isEffectivenessVerified',
          [ac(**dict(VERIFIED, effectiveness_verified_by=None))], False)
    c.add('reexport-eff-failed', 'isEffectivenessFailed', [ac(effectiveness_verified=False)], True)
    c.add('reexport-eff-not-failed', 'isEffectivenessFailed', [ac()], False)
    c.add('reexport-finding-open', 'isFindingOpen', [fi(status='Verification')], True)
    c.add('reexport-finding-voided', 'isFindingOpen', [fi(status='Voided')], False)
    c.add('reexport-finding-overdue', 'isFindingOverdue', [fi(due_date='2026-09-16'), T], True)
    c.add('reexport-finding-overdue-closed', 'isFindingOverdue',
          [fi(due_date='2026-09-16', status='Closed'), T], False)
    c.add('reexport-nonconformity', 'isNonconformity', [fi(finding_type=MINOR)], True)
    c.add('reexport-not-nonconformity', 'isNonconformity', [fi(finding_type='Observation')], False)
    c.add('reexport-age-open', 'findingAgeDays', [fi(), T], finding_age(fi(), T))
    closed = fi(status='Closed', raised_date='2026-07-01', closed_date='2026-07-15')
    c.add('reexport-age-closed', 'findingAgeDays', [closed, T], finding_age(closed, T),
          defect='ISO-2')
    for cid, f, a in [
        ('reexport-close-major-verified', fi(correction='Work stopped, permit issued.',
                                             root_cause='No permit board'), [ac(**VERIFIED)]),
        ('reexport-close-major-unverified', fi(correction='x', root_cause='y'),
         [ac(status='Complete', completed_at='2026-09-10')]),
        ('reexport-close-minor-uncorrected', fi(finding_type=MINOR), []),
        ('reexport-close-observation', fi(finding_type='Observation'), []),
        ('reexport-close-voided', fi(status='Voided'), []),
    ]:
        c.add(cid, 'canCloseFinding', [f, a], can_close_finding(f, a))
    urows = [fi(id='closed', status='Closed', due_date='2026-01-01'),
             fi(id='minor', finding_type=MINOR, due_date='2026-10-01'),
             fi(id='major-late', due_date='2026-09-01'),
             fi(id='major', due_date='2026-10-01')]
    c.sort('reexport-urgency', 'findingByUrgency', [T], urows, urgency_order(urows, T, iso_rank))

    # --- checklist --------------------------------------------------------
    for r_ in ['Conformant', 'Nonconformant', 'Observation', 'Not applicable', 'Not examined',
               None]:
        name = (r_ or 'unset').replace(' ', '-').lower()
        c.add('answered-' + name, 'isAnswered', [rs(result=r_)], answered(rs(result=r_)),
              'AS15-Q11' if r_ == 'Not applicable' else None)
    c.add('answered-na-with-reason', 'isAnswered',
          [rs(result='Not applicable', note='No lifting on this site.')], True)
    c.add('answered-empty', 'isAnswered', [{}], False)
    for cid, note in [('answered-na-blank-reason', ''), ('answered-na-whitespace-reason', '  \t '),
                      ('answered-na-null-reason', None)]:
        r_ = rs(result='Not applicable', note=note)
        c.add(cid, 'isAnswered', [r_], answered(r_), 'AS15-Q11')
    # a checklist that "finished" by marking items N/A with no reason
    na_items = [it(id='i1', item_no='2.1'), it(id='i2', item_no='2.2', criticality='Minor')]
    na_resp = [rs(id='n1', item_id='i1', result='Not applicable', note=' '),
               rs(id='n2', item_id='i2', result='Not applicable', note='No cranes on site.')]
    c.add('progress-na-without-reason-is-outstanding', 'checklistProgress', [na_items, na_resp],
          checklist_progress(na_items, na_resp), 'AS15-Q11')
    c.add('unanswered-na-without-reason', 'unansweredItems', [na_items, na_resp],
          unanswered_items(na_items, na_resp), 'AS15-Q11')
    c.add('report-refused-over-na-without-reason', 'canReportAudit',
          [au(), {'items': na_items, 'responses': na_resp}],
          can_report_audit(au(), {'items': na_items, 'responses': na_resp}), 'AS15-Q11')

    items = [it(id='i1', item_no='1.1'), it(id='i2', item_no='1.2', criticality='Minor'),
             it(id='i3', item_no='1.3', criticality='Major'),
             it(id='i4', item_no='1.4', criticality='Minor'),
             it(id='i5', item_no='1.5', criticality='Minor'),
             it(id='i6', item_no='1.6', criticality='Minor'),
             it(id='i7', item_no='1.7', criticality='Minor'),
             it(id='i8', item_no='1.8', criticality='Minor')]
    resp = [rs(id='r1', item_id='i1', result='Nonconformant', evidence='No permit.'),
            rs(id='r2', item_id='i2', result='Not applicable', note='No hot work.'),
            rs(id='r3', item_id='i3', result='Observation'),
            rs(id='r4', item_id='i4', result='Not examined', examined_on=None),
            rs(id='r9', item_id='i-other', result='Conformant')]  # not on this protocol
    for cid, i_, r_ in [('progress-mixed', items, resp),
                        ('progress-one-of-eight', items, [rs(item_id='i5')]),
                        ('progress-none', [], []),
                        ('progress-no-responses', items[:3], []),
                        ('progress-all', items[:2], [rs(item_id='i1'),
                                                     rs(id='r2', item_id='i2',
                                                        result='Not applicable', note='n/a')])]:
        c.add(cid, 'checklistProgress', [i_, r_], checklist_progress(i_, r_))
    # ASC-0 R2: exact halves, half up on the exact rational (57 of 200 is 29).
    for tag, n, d in [('57-of-200', 57, 200), ('23-of-40', 23, 40), ('29-of-200', 29, 200), ('1-of-8', 1, 8)]:
        its = [it(id=f'h{k}', item_no=f'9.{k}', criticality='Minor') for k in range(d)]
        rsp = [rs(id=f'hr{k}', item_id=f'h{k}') for k in range(n)]
        c.add(f'r2-progress-half-{tag}', 'checklistProgress', [its, rsp], checklist_progress(its, rsp), 'R2')
    for tag, n, d in [('23-of-40', 23, 40), ('1-of-8', 1, 8)]:
        aus = ([au(id=f'pr{k}', status='Reported') for k in range(n)]
               + [au(id=f'pp{k}', status='Planned', planned_end='2026-12-01') for k in range(d - n)])
        c.add(f'r2-programme-half-{tag}', 'programmeProgress', [aus, T], programme_progress(aus, T), 'R2')
    c.add('progress-third', 'checklistProgress', [items[:3], [rs(item_id='i1')]],
          checklist_progress(items[:3], [rs(item_id='i1')]))
    c.add('progress-two-thirds', 'checklistProgress',
          [items[:3], [rs(item_id='i1'), rs(id='r2', item_id='i2')]],
          checklist_progress(items[:3], [rs(item_id='i1'), rs(id='r2', item_id='i2')]))

    c.add('unanswered-mixed', 'unansweredItems', [items, resp], unanswered_items(items, resp))
    c.add('unanswered-none-answered', 'unansweredItems', [items[:2], []], items[:2])
    c.add('unanswered-empty', 'unansweredItems', [[], resp], [])

    crit_items = [it(id='i1', item_no='1.1'), it(id='i2', item_no='1.2'),
                  it(id='i3', item_no='1.3', criticality='Major')]
    crit_resp = [rs(id='r1', item_id='i1', result='Nonconformant'),
                 rs(id='r2', item_id='i2', result='Nonconformant'),
                 rs(id='r3', item_id='i3', result='Nonconformant')]
    for cid, f in [('critical-none-raised', []),
                   ('critical-one-raised', [fi(response_id='r1')]),
                   ('critical-voided-does-not-count', [fi(response_id='r1', status='Voided'),
                                                       fi(id='f2', response_id='r2')]),
                   ('critical-closed-counts', [fi(response_id='r1', status='Closed'),
                                               fi(id='f2', response_id='r2')]),
                   ('critical-finding-without-response', [fi()])]:
        c.add(cid, 'criticalAnswersWithoutFindings', [crit_items, crit_resp, f],
              critical_without_findings(crit_items, crit_resp, f))
    c.add('critical-conformant', 'criticalAnswersWithoutFindings',
          [crit_items, [rs(id='r1', item_id='i1')], []], [])
    c.add('critical-unknown-item', 'criticalAnswersWithoutFindings',
          [crit_items, [rs(id='r9', item_id='i9', result='Nonconformant')], []], [])

    # --- independence -----------------------------------------------------
    for cid, a in [('indep-distinct', au()), ('indep-same', au(auditee_id='u1')),
                   ('indep-external-lead', au(lead_auditor_id=None, lead_auditor_name='X',
                                              auditee_id='u1')),
                   ('indep-external-auditee', au(auditee_id=None, auditee_name='Rig 7 OIM')),
                   ('indep-same-names-text', au(lead_auditor_id=None, auditee_id=None,
                                                lead_auditor_name='J. Obi', auditee_name='J. Obi'))]:
        c.add(cid, 'auditIndependence', [a], audit_independence(a))

    # --- report -----------------------------------------------------------
    two = [it(id='i1', item_no='1.1'), it(id='i2', item_no='1.2', criticality='Minor')]
    done = [rs(id='r1', item_id='i1'), rs(id='r2', item_id='i2', result='Not applicable',
                                          note='No hot work on site.')]
    nc = [rs(id='r1', item_id='i1', result='Nonconformant', evidence='x'),
          rs(id='r2', item_id='i2')]
    reports = [
        ('report-ok', au(), {'items': two, 'responses': done}),
        ('report-half-blank', au(), {'items': two, 'responses': done[:1]}),
        ('report-not-examined', au(), {'items': two, 'responses': [
            done[0], rs(id='r2', item_id='i2', result='Not examined', examined_on=None)]}),
        ('report-critical-nc-no-finding', au(), {'items': two, 'responses': nc}),
        ('report-critical-nc-finding', au(), {'items': two, 'responses': nc,
                                              'findings': [fi(response_id='r1')]}),
        ('report-critical-nc-voided-finding', au(), {'items': two, 'responses': nc,
                                                     'findings': [fi(response_id='r1',
                                                                     status='Voided')]}),
        ('report-minor-nc-no-finding', au(), {'items': two, 'responses': [
            rs(id='r1', item_id='i1'),
            rs(id='r2', item_id='i2', result='Nonconformant', evidence='x')]}),
        ('report-adhoc-no-template', au(template_id=None), {}),
        ('report-adhoc-still-checks-critical', au(template_id=None),
         {'items': two, 'responses': nc[:1]}),
        ('report-no-conclusion', au(conclusion=' '), {'items': two, 'responses': done}),
        ('report-external-lead', au(lead_auditor_id=None, lead_auditor_name='Contract auditor'),
         {'items': two, 'responses': done}),
        ('report-no-lead', au(lead_auditor_id=None), {'items': two, 'responses': done}),
        ('report-cancelled', au(status='Cancelled'), {'items': two, 'responses': done}),
        ('report-template-empty-protocol', au(), {}),
    ]
    for cid, a, ctx in reports:
        c.add(cid, 'canReportAudit', [a, ctx], can_report_audit(a, ctx))

    closes = [
        ('close-not-reported', au(), []),
        ('close-ok', au(status='Reported'), [fi(status='Closed'), fi(id='f2', finding_type=MINOR)]),
        ('close-open-major', au(status='Reported'), [fi(status='Action in progress')]),
        ('close-voided-major', au(status='Reported'), [fi(status='Voided')]),
        ('close-open-stop-work-minor', au(status='Reported'),
         [fi(finding_type=MINOR, stop_work=True, correction='Stopped the lift.')]),
        ('close-closed-stop-work', au(status='Reported'),
         [fi(finding_type=MINOR, stop_work=True, correction='x', status='Closed')]),
        ('close-already', au(status='Closed'), []),
    ]
    for cid, a, f in closes:
        c.add(cid, 'canCloseAudit', [a, f], can_close_audit(a, f))

    cancels = [
        ('cancel-with-reason', au(status='Planned'), {'cancellation_reason': 'Contractor demobilised.'}),
        ('cancel-no-reason', au(status='Planned'), {}),
        ('cancel-blank-reason', au(status='Planned'), {'cancellation_reason': '   '}),
        ('cancel-reason-on-record', au(status='In progress', cancellation_reason='Site shut in.'), {}),
        ('cancel-patch-blanks-record', au(status='In progress', cancellation_reason='Site shut in.'),
         {'cancellation_reason': ''}),
        ('cancel-already-cancelled', au(status='Cancelled', cancellation_reason='x'),
         {'cancellation_reason': 'y'}),
        ('cancel-closed', au(status='Closed'), {'cancellation_reason': 'y'}),
    ]
    for cid, a, p in cancels:
        c.add(cid, 'canCancelAudit', [a, p], can_cancel_audit(a, p))
    c.add('cancel-no-patch-arg', 'canCancelAudit', [au(status='Planned')],
          can_cancel_audit(au(status='Planned')))

    for s in AUDIT_STATUSES + ['Nope']:
        c.add('next-audit-' + s.replace(' ', '-').lower(), 'nextAuditStatuses', [s],
              next_statuses(TRANSITIONS, s))
    adv = [
        ('advance-start', au(status='Planned'), 'In progress', {}),
        ('advance-skip-to-report', au(status='Planned'), 'Reported',
         {'items': two, 'responses': done}),
        ('advance-report-ok', au(), 'Reported', {'items': two, 'responses': done}),
        ('advance-report-blank', au(), 'Reported', {'items': two, 'responses': []}),
        ('advance-close-ok', au(status='Reported'), 'Closed', {'findings': []}),
        ('advance-close-stop-work', au(status='Reported'), 'Closed',
         {'findings': [fi(finding_type=MINOR, stop_work=True, correction='x')]}),
        ('advance-cancel-reason', au(status='Planned'), 'Cancelled',
         {'patch': {'cancellation_reason': 'Weather.'}}),
        ('advance-cancel-no-reason', au(status='Planned'), 'Cancelled', {}),
        ('advance-cancel-reported', au(status='Reported'), 'Cancelled',
         {'patch': {'cancellation_reason': 'x'}}),
        ('advance-reopen', au(), 'In progress', {}),
        ('advance-final', au(status='Cancelled', cancellation_reason='x'), 'Planned', {}),
    ]
    for cid, a, to, ctx in adv:
        c.add(cid, 'canAdvanceAudit', [a, to, ctx], can_advance_audit(a, to, ctx))

    for cid, a in [('overdue-planned', au(status='Planned', planned_end='2026-09-16')),
                   ('overdue-today', au(status='In progress', planned_end='2026-09-17')),
                   ('overdue-fieldwork', au(planned_end='2026-09-05')),
                   ('overdue-reported', au(status='Reported', planned_end='2026-08-01')),
                   ('overdue-closed', au(status='Closed', planned_end='2026-08-01')),
                   ('overdue-cancelled', au(status='Cancelled', planned_end='2026-08-01',
                                            cancellation_reason='x')),
                   ('overdue-no-end', au(status='Planned', planned_end=None))]:
        c.add(cid, 'isAuditOverdue', [a, T], audit_overdue(a, T))

    # --- programme --------------------------------------------------------
    prog_audits = [
        au(id='a1', status='Reported'), au(id='a2', status='Closed'),
        au(id='a3', status='Cancelled', cancellation_reason='Contractor demobilised.'),
        au(id='a4', status='Planned', planned_end='2026-09-01'),
        au(id='a5', status='In progress', planned_end='2026-12-01'),
        au(id='a6', status='Fieldwork complete', planned_end='2026-09-10'),
        au(id='a7', status='Planned', planned_end=None),
    ]
    for cid, a in [('progress-programme-mixed', prog_audits),
                   ('progress-programme-empty', []),
                   ('progress-programme-all-planned', [au(status='Planned', planned_end='2026-12-01'),
                                                       au(id='a2', status='Planned',
                                                          planned_end='2026-12-02')]),
                   ('progress-programme-cancelled-only', [au(status='Cancelled',
                                                             cancellation_reason='x')]),
                   ('progress-programme-one-of-eight',
                    [au(id=f'a{i}', status='Reported' if i == 0 else 'Planned',
                        planned_end='2026-12-01') for i in range(8)])]:
        c.add(cid, 'programmeProgress', [a, T], programme_progress(a, T))

    # ASC-0 R1: one authority for "outstanding" under AS15-Q11. The
    # compliance course's repro: a cancellation with no reason inside a
    # programme is outstanding, in programmeProgress AND in summarise.
    r1_audits = [
        au(id='a1', status='Reported'),
        au(id='a2', status='Cancelled', cancellation_reason=None),
        au(id='a3', status='Cancelled', cancellation_reason='Plant shutdown'),
        au(id='a4', status='Planned', planned_end='2026-09-01'),
    ]
    r1_blank = [
        au(id='b1', status='Cancelled', cancellation_reason='   '),
        au(id='b2', status='Cancelled', cancellation_reason=''),
        au(id='b3', status='Cancelled', cancellation_reason='Asset sold.'),
        au(id='b4', status='Closed'),
    ]
    R1_T = date('2026-10-15')
    c.add('r1-programme-reasonless-cancellation', 'programmeProgress', [r1_audits, R1_T],
          programme_progress(r1_audits, R1_T), 'R1')
    c.add('r1-programme-blank-reasons', 'programmeProgress', [r1_blank, T],
          programme_progress(r1_blank, T), 'R1')
    c.add('r1-summarise-reasonless-cancellation', 'summarise', [{'audits': r1_audits}, R1_T],
          summarise({'audits': r1_audits}, R1_T), 'R1')
    c.add('r1-summarise-blank-reasons', 'summarise', [{'audits': r1_blank}, T],
          summarise({'audits': r1_blank}, T), 'R1')
    assert (programme_progress(r1_audits, R1_T)['outstanding']
            == summarise({'audits': r1_audits}, R1_T)['auditsOutstanding'] == 2)

    for cid, p, patch in [('approve-ok', pg(status='Draft'), {}),
                          ('approve-no-date', pg(status='Draft', approved_at=None), {}),
                          ('approve-no-name', pg(status='Draft', approved_by=None), {}),
                          ('approve-named-in-text', pg(status='Draft', approved_by=None),
                           {'approver_name': 'HSE Director'}),
                          ('approve-blank-name', pg(status='Draft', approved_by=None),
                           {'approver_name': '  '}),
                          ('approve-date-in-patch', pg(status='Draft', approved_at=None),
                           {'approved_at': '2026-02-01'})]:
        c.add(cid, 'canApproveProgramme', [p, patch], can_approve_programme(p, patch))
    c.add('approve-no-patch-arg', 'canApproveProgramme', [pg()], can_approve_programme(pg()))

    for cid, p, a in [
        ('complete-all-done', pg(), prog_audits[:3]),
        ('complete-outstanding', pg(), prog_audits),
        ('complete-cancelled-with-reason', pg(), [au(status='Cancelled',
                                                     cancellation_reason='Rig released.')]),
        ('complete-empty', pg(), []),
        ('complete-already', pg(status='Complete'), []),
        ('complete-cancelled-programme', pg(status='Cancelled'), []),
    ]:
        c.add(cid, 'canCompleteProgramme', [p, a], can_complete_programme(p, a))
    # AS15-Q11: a Cancelled audit with no reason should never be stored
    # (audit_records_cancel_needs_reason), and the engine no longer trusts
    # that it was not: it stays outstanding. Was complete-cancelled-no-reason-trusts-status.
    for cid, reason in [('complete-cancelled-no-reason-outstanding', None),
                        ('complete-cancelled-blank-reason-outstanding', ''),
                        ('complete-cancelled-whitespace-reason-outstanding', '   ')]:
        a_ = [au(id='a1', status='Reported'), au(id='a2', status='Cancelled', cancellation_reason=reason)]
        c.add(cid, 'canCompleteProgramme', [pg(), a_], can_complete_programme(pg(), a_), 'AS15-Q11')

    for s in ['Draft', 'Approved', 'In progress', 'Complete', 'Cancelled', 'Nope']:
        c.add('next-programme-' + s.replace(' ', '-').lower(), 'nextProgrammeStatuses', [s],
              next_statuses(PROGRAMME_TRANSITIONS, s))
    for cid, p, to, ctx in [
        ('prog-approve-ok', pg(status='Draft'), 'Approved', {}),
        ('prog-approve-missing', pg(status='Draft', approved_at=None), 'Approved', {}),
        ('prog-approve-with-patch', pg(status='Draft', approved_at=None, approved_by=None),
         'Approved', {'patch': {'approved_at': '2026-01-10', 'approved_by': 'u9'}}),
        ('prog-start', pg(status='Approved'), 'In progress', {}),
        ('prog-complete-ok', pg(), 'Complete', {'audits': prog_audits[:3]}),
        ('prog-complete-outstanding', pg(), 'Complete', {'audits': prog_audits}),
        ('prog-complete-no-audits-ctx', pg(), 'Complete', {}),
        ('prog-skip', pg(status='Draft'), 'Complete', {'audits': []}),
        ('prog-cancel', pg(status='Approved'), 'Cancelled', {}),
        ('prog-final', pg(status='Complete'), 'In progress', {}),
    ]:
        c.add(cid, 'canAdvanceProgramme', [p, to, ctx], can_advance_programme(p, to, ctx))

    # --- raising a finding ------------------------------------------------
    for cid, f in [
        ('raise-ok', fi()),
        ('raise-bad-type', fi(finding_type='Critical')),
        ('raise-no-title', fi(title='  ')),
        ('raise-no-evidence', fi(objective_evidence=None)),
        ('raise-stop-work-no-correction', fi(stop_work=True)),
        ('raise-stop-work-corrected', fi(stop_work=True, correction='Lift stopped, area barricaded.')),
        ('raise-stop-work-minor', fi(finding_type=MINOR, stop_work=True, correction='x')),
        ('raise-stop-work-observation', fi(finding_type='Observation', stop_work=True,
                                           correction='x')),
        ('raise-stop-work-ofi', fi(finding_type='Opportunity for improvement', stop_work=True,
                                   correction='x')),
        ('raise-observation', fi(finding_type='Observation')),
    ]:
        c.add(cid, 'canRaiseFinding', [f], can_raise_finding(f))

    # --- summarise --------------------------------------------------------
    sd = {
        'programmes': [pg(), pg(id='p2', status='Approved'), pg(id='p3', status='Draft'),
                       pg(id='p4', status='Complete')],
        'templates': [{'id': 't1', 'status': 'Active'}, {'id': 't2', 'status': 'Retired'},
                      {'id': 't3', 'status': 'Draft'}],
        'audits': prog_audits,
        'responses': resp + [rs(id='r5', item_id='i5', result=None)],
        'findings': [fi(), fi(id='f2', stop_work=True, correction='x', due_date='2026-09-10'),
                     fi(id='f3', finding_type=MINOR, stop_work=True, correction='x',
                        status='Closed'),
                     fi(id='f4', finding_type='Observation', due_date='2026-09-01'),
                     fi(id='f5', finding_type=MINOR, status='Voided'),
                     fi(id='f6', finding_type='Opportunity for improvement')],
        'actions': [ac(due_date='2026-09-01'), ac(id='x2', status='Complete'),
                    ac(id='x3', **VERIFIED),
                    ac(id='x4', status='Complete', effectiveness_verified=False,
                       effectiveness_checked_at='2026-09-12', effectiveness_verified_by='u3'),
                    ac(id='x5', status='Cancelled', due_date='2026-01-01')],
    }
    c.add('summary-mixed', 'summarise', [sd, T], summarise(sd, T))
    c.add('summary-empty', 'summarise', [{}, T], summarise({}, T))

    rows = [{'auditee_name': 'Rig 7'}, {'auditee_name': 'Yard'}, {'auditee_name': 'Yard'},
            {'auditee_name': None}, {}]
    c.add('countby-auditee', 'countBy', [rows, 'auditee_name'], count_by(rows, 'auditee_name'))
    c.add('countby-custom-unset', 'countBy', [rows, 'auditee_name', 'No auditee'],
          count_by(rows, 'auditee_name', 'No auditee'))
    c.add('countby-empty', 'countBy', [[], 'x'], [])

    arows = [
        fi(id='closed-stop', status='Closed', stop_work=True, correction='x'),
        fi(id='obs-late', finding_type='Observation', due_date='2026-09-01'),
        fi(id='major', due_date='2026-10-01'),
        fi(id='minor-open', finding_type=MINOR, due_date='2026-09-30'),
        fi(id='stop-minor', finding_type=MINOR, stop_work=True, correction='x',
           due_date='2026-12-01'),
        fi(id='major-late', due_date='2026-09-10'),
        fi(id='stop-major', stop_work=True, correction='x', due_date='2026-11-01'),
        fi(id='voided', status='Voided', due_date='2025-01-01'),
        fi(id='minor-undated', finding_type=MINOR, raised_date=None),
    ]
    c.sort('attention-mixed', 'findingByAttention', [T], arows,
           urgency_order(arows, T, attention_rank))
    return c


def main():
    c = build()
    doc = {
        'module': 'auditManagement',
        'generatedBy': 'tools/validation/assurance/oracle_audit.py',
        'description': ('Audit & Findings Manager (AS10) rules from the docstrings, '
                        'AssuranceApps-STATUS.md 3i and the AS10 migration header; finding and '
                        'action rules shared with oracle_iso.py by design.'),
        'cases': c.cases,
    }
    OUT.write_text(json.dumps(doc, indent=1) + '\n')
    n = len(c.cases)
    k = sum(1 for x in c.cases if x.get('repaired'))
    print(f'{OUT.relative_to(ROOT)}: {n} cases, {k} repaired')


if __name__ == '__main__':
    main()
