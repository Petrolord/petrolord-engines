#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/isoCompliance.js (AS8, ISO Compliance).

Stdlib-only Python 3. Written from the METHOD STATEMENTS, not from the
JavaScript bodies:

  * the module docstrings of isoCompliance.js,
  * docs/scope/AssuranceApps-STATUS.md section 3g (AS8),
  * migration 20260917600000_as8_iso_compliance.sql (the check constraints
    the engine says it mirrors),
  * ISO 9001:2015 section 4.3 (a requirement determined not applicable keeps
    its justification), 9.2 (the organization runs its OWN internal audit
    programme), 10.2 (correction + corrective action; effectiveness reviewed),
  * ISO 19011:2018 section 4 / 7.2 (objectivity: auditors do not audit their
    own work).

Only signatures, input field names and vocabularies were read from the JS.
Where a rule is taken from the code rather than the docs, FINDINGS-iso.md
says so.

Calendar model: a 'YYYY-MM-DD' is a calendar date and Python datetime.date
arithmetic is the independent model of the engine's local-midnight rounding.
"N years before today" is the calendar-library convention (Postgres
`date - interval 'N years'`, date-fns subYears, dateutil relativedelta):
29 February steps back to 28 February when the target year has no 29th.

Usage:  python3 tools/validation/assurance/oracle_iso.py
Writes: test-data/assurance/goldens/isoCompliance_cases.json
"""
import datetime as dt
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'test-data' / 'assurance' / 'goldens' / 'isoCompliance_cases.json'

D = dt.date


class _Undef:
    """An explicit JS `undefined` argument."""


UNDEF = _Undef()


class _InvalidDate:
    """A JS Invalid Date passed as an argument."""


INVALID = _InvalidDate()


def date(s):
    return D.fromisoformat(s)


# ---------------------------------------------------------------------------
# Truthiness and text, as the rules state them ("named", "recorded")
# ---------------------------------------------------------------------------

def present(v):
    """A value that is recorded at all: not missing, not empty, not false."""
    return not (v is None or v is UNDEF or v is False or v == '' or v == 0)


def written(v):
    """A text field that says something: not missing and not only whitespace."""
    if not present(v):
        return False
    return str(v).strip() != ''


# ---------------------------------------------------------------------------
# Calendar dates
# ---------------------------------------------------------------------------

_YMD = re.compile(r'^(\d{4})-(\d{2})-(\d{2})')


def parse_date(v):
    """A calendar date, or None. A string must begin with a REAL YYYY-MM-DD."""
    if v is INVALID or not present(v):
        return None
    if isinstance(v, D):
        return v
    if isinstance(v, str):
        m = _YMD.match(v)
        if not m:
            return None
        try:
            return D(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None  # 2026-02-30 names no day (CAL-1 in FINDINGS-calendar)
    return None


def days_until(v, today):
    t = parse_date(v)
    if t is None:
        return None
    return (t - today).days


def ymd(v):
    t = parse_date(v)
    return None if t is None else t.isoformat()


def years_before(today, n):
    """The same calendar day n years earlier; 29 Feb falls back to 28 Feb."""
    y = today.year - n
    try:
        return D(y, today.month, today.day)
    except ValueError:
        return D(y, today.month, 28)


# ---------------------------------------------------------------------------
# Vocabularies (read from the module; they are the migration's constraints)
# ---------------------------------------------------------------------------

CLAUSE_STATUSES = ['Not assessed', 'Conformant', 'Partially conformant', 'Nonconformant',
                   'Not applicable']
CLAIMS = ['Conformant', 'Partially conformant']
AUDIT_STATUSES = ['Planned', 'In progress', 'Fieldwork complete', 'Reported', 'Closed',
                  'Cancelled']
AUDIT_OPEN = ['Planned', 'In progress', 'Fieldwork complete', 'Reported']
AUDIT_FINAL = ['Closed', 'Cancelled']
EXAMINED = ['Conformant', 'Nonconformant', 'Observation', 'Not applicable']
FINDING_TYPES = ['Major nonconformity', 'Minor nonconformity', 'Observation',
                 'Opportunity for improvement']
MAJOR = 'Major nonconformity'
MINOR = 'Minor nonconformity'
FINDING_OPEN = ['Open', 'Correction proposed', 'Action in progress', 'Verification']
FINDING_FINAL = ['Closed', 'Voided']
ACTION_DONE = ['Complete', 'Cancelled']
REVIEW_LEAD = 30
CERT_LEAD = 90

# The audit lifecycle as the STATUS doc and the docstrings describe it: plan,
# fieldwork, report, close; cancellation from anywhere before the report;
# fieldwork may be reopened; a report is not withdrawn; the ends are final.
TRANSITIONS = {
    'Planned': ['In progress', 'Cancelled'],
    'In progress': ['Fieldwork complete', 'Cancelled'],
    'Fieldwork complete': ['Reported', 'In progress', 'Cancelled'],
    'Reported': ['Closed'],
    'Closed': [],
    'Cancelled': [],
}


def refuse():
    return {'ok': False}


def allow():
    return {'ok': True}


# ---------------------------------------------------------------------------
# Corrective actions (the AS7 rules, shared by design)
# ---------------------------------------------------------------------------

def action_open(a):
    return a.get('status') not in ACTION_DONE


def action_overdue(a, today):
    if not action_open(a):
        return False
    n = days_until(a.get('due_date'), today)
    return n is not None and n < 0


def verified_effective(a):
    """Somebody looked, said yes, and the look is dated and signed."""
    return (a.get('effectiveness_verified') is True
            and present(a.get('effectiveness_checked_at'))
            and present(a.get('effectiveness_verified_by')))


def found_ineffective(a):
    return a.get('effectiveness_verified') is False


# ---------------------------------------------------------------------------
# Clauses
# ---------------------------------------------------------------------------

def applicable(c):
    return c.get('applicability') != 'Not applicable'


def claims(c):
    return c.get('status') in CLAIMS


def assessed(c):
    return c.get('status') != 'Not assessed' and present(c.get('assessed_date'))


def assessor_named(c):
    return present(c.get('assessed_by')) or written(c.get('assessor_name'))


def evidenced(c):
    """A conformity claim is evidence, a date and a name."""
    return written(c.get('evidence_reference')) and present(c.get('assessed_date')) \
        and assessor_named(c)


def can_set_clause_status(clause, status, patch=None):
    patch = patch or {}
    if status not in CLAUSE_STATUSES:
        return refuse()
    nxt = dict(clause)
    nxt.update(patch)
    nxt['status'] = status
    excluded_status = status == 'Not applicable'
    excluded_applic = nxt.get('applicability') == 'Not applicable'
    if excluded_status or excluded_applic:
        # an exclusion cannot carry a verdict: both fields agree, and 4.3
        # keeps the justification
        if not (excluded_status and excluded_applic):
            return refuse()
        if not written(nxt.get('applicability_justification')):
            return refuse()
        return allow()
    if status in CLAIMS and not evidenced(nxt):
        return refuse()
    if status == 'Nonconformant' and not (present(nxt.get('assessed_date')) and assessor_named(nxt)):
        return refuse()
    return allow()


def review_overdue(c, today):
    if not applicable(c):
        return False
    n = days_until(c.get('next_review_due'), today)
    return n is not None and n < 0


def review_due_soon(c, today):
    if not applicable(c):
        return False
    n = days_until(c.get('next_review_due'), today)
    return n is not None and 0 <= n <= REVIEW_LEAD


# ---------------------------------------------------------------------------
# Audits
# ---------------------------------------------------------------------------

def audit_independence(audit, in_scope=None):
    """ISO 19011: a lead auditor with a Suite account may not own a clause in scope."""
    in_scope = in_scope or []
    lead = audit.get('lead_auditor_id')
    if not present(lead):
        return {'ok': True, 'clauses': []}
    owned = [c for c in in_scope if c and c.get('owner_id') == lead]
    if not owned:
        return {'ok': True, 'clauses': []}
    return {'ok': False, 'clauses': [c['clause_ref'] for c in owned if present(c.get('clause_ref'))]}


def examined(row):
    return row.get('result') in EXAMINED


def lead_named(a):
    return present(a.get('lead_auditor_id')) or written(a.get('lead_auditor_name'))


def can_report_audit(audit, coverage=None):
    coverage = coverage or []
    if audit.get('status') in AUDIT_FINAL:
        return refuse()
    if not coverage:
        return refuse()  # examined nothing, nothing to report
    if any(not examined(r) for r in coverage):
        return refuse()  # every clause in scope has a result
    if not written(audit.get('conclusion')):
        return refuse()
    if not lead_named(audit):
        return refuse()
    return allow()


def finding_open(f):
    return f.get('status') in FINDING_OPEN


def can_close_audit(audit, findings=None):
    findings = findings or []
    if audit.get('status') in AUDIT_FINAL:
        return refuse()
    if audit.get('status') != 'Reported':
        return refuse()
    if any(finding_open(f) and f.get('finding_type') == MAJOR for f in findings):
        return refuse()
    return allow()


def next_audit_statuses(s):
    return list(TRANSITIONS.get(s, [])) if isinstance(s, str) else []


def can_advance_audit(audit, to, ctx=None):
    ctx = ctx or {}
    if to not in next_audit_statuses(audit.get('status')):
        return refuse()
    if to == 'Reported':
        return can_report_audit(audit, ctx.get('coverage') or [])
    if to == 'Closed':
        return can_close_audit(audit, ctx.get('findings') or [])
    return allow()


def audit_overdue(a, today):
    """Still open (Reported counts: not finished until its findings are) past planned end."""
    if a.get('status') not in AUDIT_OPEN:
        return False
    n = days_until(a.get('planned_end'), today)
    return n is not None and n < 0


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------

def nonconformity(f):
    return f.get('finding_type') in (MAJOR, MINOR)


def finding_overdue(f, today):
    if not finding_open(f):
        return False
    n = days_until(f.get('due_date'), today)
    return n is not None and n < 0


def finding_age(f, today):
    """Days from raising to closure, or to today while it is still open (ISO-2)."""
    raised = parse_date(f.get('raised_date'))
    if raised is None:
        return None
    end = today
    if not finding_open(f):
        end = parse_date(f.get('closed_date')) or today
    return max(0, (end - raised).days)


def can_close_finding(f, actions=None):
    """ISO 9001 10.2: correction for the instance, corrective action for the cause,
    and for a major nonconformity a corrective action verified effective."""
    actions = actions or []
    if f.get('status') in FINDING_FINAL:
        return refuse()
    if nonconformity(f) and not written(f.get('correction')):
        return refuse()
    if any(action_open(a) for a in actions):
        return refuse()
    if f.get('finding_type') == MAJOR:
        if not written(f.get('root_cause')):
            return refuse()
        corrective = [a for a in actions
                      if a.get('action_type') == 'Corrective' and a.get('status') != 'Cancelled']
        if not any(verified_effective(a) for a in corrective):
            return refuse()  # none at all, or none shown to work
    return allow()


# ---------------------------------------------------------------------------
# Coverage over the certification cycle
# ---------------------------------------------------------------------------

def last_examinations(audit_clauses, audits):
    """clause_id -> (date, audit, result) for the latest INTERNAL examination."""
    by_id = {a.get('id'): a for a in audits}
    last = {}
    for row in audit_clauses:
        if not examined(row):
            continue
        a = by_id.get(row.get('audit_id'))
        if a is None or a.get('audit_type') != 'Internal':
            continue  # 9.2: only the organization's own programme counts
        when = parse_date(row.get('examined_on')) or parse_date(a.get('actual_end'))
        if when is None:
            continue
        cur = last.get(row.get('clause_id'))
        if cur is None or when > cur[0]:
            last[row.get('clause_id')] = (when, a, row.get('result'))
    return last


def coverage_row(clause, last, cycle_start):
    row = {'clause': clause}
    if 'clause_ref' in clause:
        row['clause_ref'] = clause['clause_ref']
    if last is None:
        row.update({'lastExaminedOn': None, 'lastAudit': None, 'lastResult': None,
                    'covered': False, 'stale': False})
    else:
        when, a, result = last
        row.update({'lastExaminedOn': when.isoformat(), 'lastAudit': a, 'lastResult': result,
                    'covered': when >= cycle_start, 'stale': when < cycle_start})
    return row


def clause_coverage(data=None, today=None):
    data = data or {}
    clauses = data.get('clauses', [])
    cycle = data.get('cycleYears', 3)
    start = years_before(today, cycle)
    last = last_examinations(data.get('auditClauses', []), data.get('audits', []))
    return [coverage_row(c, last.get(c.get('id')), start) for c in clauses if applicable(c)]


# ---------------------------------------------------------------------------
# Certification readiness: counted, named blockers
# ---------------------------------------------------------------------------

def certification_readiness(standard, data=None, today=None):
    data = data or {}
    sid = standard.get('id')
    mine = [c for c in data.get('clauses', []) if not present(sid) or c.get('standard_id') == sid]
    appl = [c for c in mine if applicable(c)]
    my_f = [f for f in data.get('findings', []) if not present(sid) or f.get('standard_id') == sid]
    cycle = standard.get('cycle_years') or 3
    cov = clause_coverage({'clauses': mine, 'auditClauses': data.get('auditClauses', []),
                           'audits': data.get('audits', []), 'cycleYears': cycle}, today)

    never = sum(1 for r in cov if r['lastExaminedOn'] is None)
    stale = sum(1 for r in cov if r['stale'])
    not_assessed = sum(1 for c in appl if not assessed(c))
    unevidenced = sum(1 for c in appl if claims(c) and not evidenced(c))
    nonconf = sum(1 for c in appl if c.get('status') == 'Nonconformant')
    reviews = sum(1 for c in appl if review_overdue(c, today))
    open_major = sum(1 for f in my_f if finding_open(f) and f.get('finding_type') == MAJOR)
    open_minor = sum(1 for f in my_f if finding_open(f) and f.get('finding_type') == MINOR)
    f_overdue = sum(1 for f in my_f if finding_overdue(f, today))
    fids = {f.get('id') for f in my_f}
    a_overdue = sum(1 for a in data.get('actions', [])
                    if a.get('finding_id') in fids and action_overdue(a, today))

    # Order: blocking, serious, watch; within each, the order the module
    # lists them (taken from the code, see FINDINGS-iso.md).
    listed = [('blocking', open_major), ('blocking', never), ('blocking', unevidenced),
              ('blocking', nonconf), ('serious', stale), ('serious', not_assessed),
              ('serious', a_overdue), ('watch', open_minor), ('watch', reviews),
              ('watch', f_overdue)]
    blockers = [{'severity': s, 'count': n} for s, n in listed if n > 0]
    if not appl:
        blockers.insert(0, {'severity': 'blocking', 'count': 0})

    cert = days_until(standard.get('certificate_expires'), today)
    return {
        'ready': not any(b['severity'] == 'blocking' for b in blockers),
        'blockers': blockers,
        'counts': {
            'clauses': len(mine),
            'applicable': len(appl),
            'excluded': len(mine) - len(appl),
            'assessed': sum(1 for c in appl if assessed(c)),
            'evidenced': sum(1 for c in appl if claims(c) and evidenced(c)),
            'conformant': sum(1 for c in appl if c.get('status') == 'Conformant'),
            'partial': sum(1 for c in appl if c.get('status') == 'Partially conformant'),
            'nonconformant': nonconf,
            'notAssessed': not_assessed,
            'covered': sum(1 for r in cov if r['covered']),
            'neverAudited': never,
            'staleAudited': stale,
            'openMajor': open_major,
            'openMinor': open_minor,
            'overdueActions': a_overdue,
            'certificateDays': cert,
            'certificateExpiring': cert is not None and cert <= CERT_LEAD,
            'certificateExpired': cert is not None and cert < 0,
        },
        'coverage': cov,
    }


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def tally(rows, field, vocab, pred=lambda r: True):
    out = {k: 0 for k in vocab}
    for r in rows:
        if r.get(field) in out and pred(r):
            out[r.get(field)] += 1
    return out


def summarise(data=None, today=None):
    data = data or {}
    standards = data.get('standards', [])
    clauses = data.get('clauses', [])
    audits = data.get('audits', [])
    findings = data.get('findings', [])
    actions = data.get('actions', [])
    appl = [c for c in clauses if applicable(c)]

    # Coverage is counted over EACH clause's own standard's cycle (ISO-1).
    cycle_of = {s.get('id'): (s.get('cycle_years') or 3) for s in standards}
    last = last_examinations(data.get('auditClauses', []), audits)
    cov = [coverage_row(c, last.get(c.get('id')),
                        years_before(today, cycle_of.get(c.get('standard_id'), 3)))
           for c in appl]

    open_by_type = tally(findings, 'finding_type', FINDING_TYPES, finding_open)
    return {
        'standards': len(standards),
        'certified': sum(1 for s in standards if s.get('certification_status') == 'Certified'),
        'clauses': len(clauses),
        'applicable': len(appl),
        'excluded': len(clauses) - len(appl),
        'byClauseStatus': tally(clauses, 'status', CLAUSE_STATUSES),
        'evidencedClaims': sum(1 for c in appl if claims(c) and evidenced(c)),
        'unevidencedClaims': sum(1 for c in appl if claims(c) and not evidenced(c)),
        'notAssessed': sum(1 for c in appl if not assessed(c)),
        'reviewsOverdue': sum(1 for c in appl if review_overdue(c, today)),
        'reviewsDueSoon': sum(1 for c in appl if review_due_soon(c, today)),
        'audits': len(audits),
        'byAuditStatus': tally(audits, 'status', AUDIT_STATUSES),
        'auditsOpen': sum(1 for a in audits if a.get('status') in AUDIT_OPEN),
        'auditsOverdue': sum(1 for a in audits if audit_overdue(a, today)),
        'clausesCovered': sum(1 for r in cov if r['covered']),
        'clausesNeverAudited': sum(1 for r in cov if r['lastExaminedOn'] is None),
        'clausesStale': sum(1 for r in cov if r['stale']),
        'findings': len(findings),
        'openFindings': sum(1 for f in findings if finding_open(f)),
        'byFindingType': tally(findings, 'finding_type', FINDING_TYPES),
        'openByFindingType': open_by_type,
        'openMajor': open_by_type[MAJOR],
        'findingsOverdue': sum(1 for f in findings if finding_overdue(f, today)),
        'actions': len(actions),
        'openActions': sum(1 for a in actions if action_open(a)),
        'overdueActions': sum(1 for a in actions if action_overdue(a, today)),
        # complete, and nobody has yet said whether it worked
        'actionsAwaitingEffectiveness': sum(
            1 for a in actions if a.get('status') == 'Complete'
            and a.get('effectiveness_verified') not in (True, False)),
        'actionsVerifiedEffective': sum(1 for a in actions if verified_effective(a)),
        'actionsFoundIneffective': sum(1 for a in actions if found_ineffective(a)),
    }


def count_by(rows=None, field=None, unset='Unspecified'):
    rows = rows or []
    counts = {}
    for r in rows:
        v = r.get(field) if isinstance(r, dict) else None
        key = v if present(v) else unset
        counts[key] = counts.get(key, 0) + 1
    ordered = list(counts.items())  # first appearance
    ordered.sort(key=lambda kv: -kv[1])  # stable: ties keep first appearance
    return [{'name': k, 'count': n} for k, n in ordered]


def urgency_order(rows, today, rank):
    def key(f):
        due = parse_date(f.get('due_date') or f.get('raised_date'))
        return (rank(f, today), 0 if due else 1, due or D.min)
    return [r['id'] for r in sorted(rows, key=key)]


def iso_rank(f, today):
    if finding_open(f) and f.get('finding_type') == MAJOR:
        return 0 if finding_overdue(f, today) else 1
    if finding_open(f) and finding_overdue(f, today):
        return 2
    if finding_open(f):
        return 3
    return 4


# ---------------------------------------------------------------------------
# Golden file writer
# ---------------------------------------------------------------------------

def enc(v):
    if v is UNDEF:
        return {'$undefined': True}
    if v is INVALID:
        return {'$date': None}
    if isinstance(v, D):
        return {'$date': v.isoformat()}
    if isinstance(v, dict):
        return {k: enc(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    return v


class Cases:
    def __init__(self):
        self.cases = []

    def add(self, cid, fn, args, expected, defect=None):
        c = {'id': cid, 'fn': fn, 'args': enc(args), 'expected': enc(expected)}
        if defect:
            c['repaired'] = defect
        self.cases.append(c)

    def throws(self, cid, fn, args):
        self.cases.append({'id': cid, 'fn': fn, 'args': enc(args), 'expectedThrows': True})

    def sort(self, cid, name, factory_args, rows, order):
        self.cases.append({'id': cid, 'sort': name, 'factory': True,
                           'factoryArgs': enc(factory_args), 'rows': enc(rows),
                           'expectedOrder': order})


T = date('2026-09-17')


def std(**o):
    s = {'id': 's1', 'code': 'ISO 9001:2015', 'certification_status': 'Certified',
         'certificate_expires': '2029-03-31', 'cycle_years': 3}
    s.update(o)
    return s


def cl(**o):
    c = {'id': 'c1', 'standard_id': 's1', 'clause_ref': '7.1.5', 'applicability': 'Applicable',
         'status': 'Not assessed'}
    c.update(o)
    return c


def ev(**o):
    c = cl(status='Conformant', evidence_reference='QMS-PR-009 rev 4',
           assessed_date='2026-06-01', assessed_by='u1')
    c.update(o)
    return c


def au(**o):
    a = {'id': 'a1', 'audit_code': 'IA-2026-001', 'standard_id': 's1', 'audit_type': 'Internal',
         'status': 'Fieldwork complete', 'lead_auditor_id': 'u9',
         'conclusion': 'Conforms, with two minor nonconformities.'}
    a.update(o)
    return a


def cov(**o):
    r = {'id': 'ac1', 'audit_id': 'a1', 'clause_id': 'c1', 'clause_ref': '7.1.5',
         'result': 'Conformant', 'examined_on': '2026-09-02'}
    r.update(o)
    return r


def fi(**o):
    f = {'id': 'f1', 'finding_code': 'ISF-2026-001', 'audit_id': 'a1', 'standard_id': 's1',
         'finding_type': MAJOR, 'title': 'Uncalibrated gauge', 'status': 'Open',
         'raised_date': '2026-09-01'}
    f.update(o)
    return f


def ac(**o):
    a = {'id': 'x1', 'finding_id': 'f1', 'action_type': 'Corrective', 'status': 'Open'}
    a.update(o)
    return a


VERIFIED = dict(status='Complete', completed_at='2026-09-10', effectiveness_verified=True,
                effectiveness_checked_at='2026-09-15', effectiveness_verified_by='u3')


def build():
    c = Cases()

    # --- shared date helpers (re-exported from AS7 / calendar) -------------
    for cid, v in [('parse-string', '2026-09-17'), ('parse-timestamp', '2026-09-17T23:30:00Z'),
                   ('parse-date', date('2024-02-29')), ('parse-empty', ''),
                   ('parse-null', None), ('parse-garbage', 'next Tuesday'),
                   ('parse-invalid-date', INVALID)]:
        c.add(cid, 'parseDateOnly', [v], parse_date(v))
    c.add('parse-feb-30', 'parseDateOnly', ['2026-02-30'], parse_date('2026-02-30'), defect='CAL-1')
    for cid, v in [('days-future', '2026-10-17'), ('days-past', '2026-09-16'),
                   ('days-today', '2026-09-17'), ('days-none', None),
                   ('days-across-leap', '2028-02-29')]:
        c.add(cid, 'daysUntil', [v, T], days_until(v, T))
    c.add('ymd-string', 'toDateOnlyString', ['2026-01-05T08:00:00'], ymd('2026-01-05T08:00:00'))
    c.add('ymd-date', 'toDateOnlyString', [date('2028-02-29')], '2028-02-29')
    c.add('ymd-null', 'toDateOnlyString', [None], None)

    # --- action helpers imported from AS7 ----------------------------------
    for cid, a in [('action-open-open', ac()), ('action-open-progress', ac(status='In progress')),
                   ('action-open-complete', ac(status='Complete')),
                   ('action-open-cancelled', ac(status='Cancelled'))]:
        c.add(cid, 'isActionOpen', [a], action_open(a))
    for cid, a in [('action-overdue-yes', ac(due_date='2026-09-16')),
                   ('action-overdue-today', ac(due_date='2026-09-17')),
                   ('action-overdue-complete', ac(due_date='2026-01-01', status='Complete')),
                   ('action-overdue-nodate', ac())]:
        c.add(cid, 'isActionOverdue', [a, T], action_overdue(a, T))
    for cid, a in [('eff-verified', ac(**VERIFIED)),
                   ('eff-unsigned', ac(**dict(VERIFIED, effectiveness_verified_by=None))),
                   ('eff-undated', ac(**dict(VERIFIED, effectiveness_checked_at=None))),
                   ('eff-string-true', ac(**dict(VERIFIED, effectiveness_verified='true')))]:
        c.add(cid, 'isEffectivenessVerified', [a], verified_effective(a))
    for cid, a in [('eff-failed', ac(effectiveness_verified=False)),
                   ('eff-failed-null', ac(effectiveness_verified=None)), ('eff-failed-absent', ac())]:
        c.add(cid, 'isEffectivenessFailed', [a], found_ineffective(a))

    # --- clauses ----------------------------------------------------------
    for cid, x in [('applicable', cl()), ('applicable-excluded', cl(applicability='Not applicable')),
                   ('applicable-unset', {'id': 'c9'})]:
        c.add(cid, 'isApplicable', [x], applicable(x))
    for cid, x in [('claims-conformant', cl(status='Conformant')),
                   ('claims-partial', cl(status='Partially conformant')),
                   ('claims-nonconformant', cl(status='Nonconformant')),
                   ('claims-not-assessed', cl())]:
        c.add(cid, 'claimsConformity', [x], claims(x))
    for cid, x in [('assessed-dated', ev()), ('assessed-undated', ev(assessed_date=None)),
                   ('assessed-not', cl(assessed_date='2026-01-01'))]:
        c.add(cid, 'isAssessed', [x], assessed(x))
    for cid, x in [('evidence-full', ev()), ('evidence-external-assessor',
                                             ev(assessed_by=None, assessor_name='LR surveyor')),
                   ('evidence-blank-ref', ev(evidence_reference='   ')),
                   ('evidence-no-date', ev(assessed_date=None)),
                   ('evidence-blank-assessor', ev(assessed_by=None, assessor_name='  '))]:
        c.add(cid, 'hasEvidenceRecord', [x], evidenced(x))

    scs = [
        ('status-bad-vocab', cl(), 'Compliant', {}),
        ('status-conformant-bare', cl(), 'Conformant', {}),
        ('status-conformant-evidenced', cl(), 'Conformant',
         {'evidence_reference': 'QMS-PR-009', 'assessed_date': '2026-09-01', 'assessed_by': 'u1'}),
        ('status-partial-no-assessor', cl(), 'Partially conformant',
         {'evidence_reference': 'QMS-PR-009', 'assessed_date': '2026-09-01'}),
        ('status-partial-external', cl(), 'Partially conformant',
         {'evidence_reference': 'QMS-PR-009', 'assessed_date': '2026-09-01',
          'assessor_name': 'External assessor'}),
        ('status-nonconformant-bare', cl(), 'Nonconformant', {}),
        ('status-nonconformant-dated-named', cl(), 'Nonconformant',
         {'assessed_date': '2026-09-01', 'assessor_name': 'Q. Auditor'}),
        ('status-na-without-applicability', cl(), 'Not applicable',
         {'applicability_justification': 'No design activity.'}),
        ('status-na-no-justification', cl(), 'Not applicable', {'applicability': 'Not applicable'}),
        ('status-na-blank-justification', cl(), 'Not applicable',
         {'applicability': 'Not applicable', 'applicability_justification': '  '}),
        ('status-na-justified', cl(), 'Not applicable',
         {'applicability': 'Not applicable', 'applicability_justification': 'No design (8.3).'}),
        ('status-excluded-claimed', cl(applicability='Not applicable',
                                       applicability_justification='no design'),
         'Conformant', {'evidence_reference': 'x', 'assessed_date': '2026-09-01',
                        'assessed_by': 'u1'}),
        ('status-not-assessed', ev(), 'Not assessed', {}),
        ('status-reinclude', cl(applicability='Not applicable', status='Not applicable',
                                applicability_justification='no design'),
         'Not assessed', {'applicability': 'Applicable'}),
    ]
    for cid, x, s, p in scs:
        c.add(cid, 'canSetClauseStatus', [x, s, p], can_set_clause_status(x, s, p))

    for cid, x in [('review-overdue', cl(next_review_due='2026-09-16')),
                   ('review-today', cl(next_review_due='2026-09-17')),
                   ('review-none', cl()),
                   ('review-excluded', cl(applicability='Not applicable',
                                          next_review_due='2020-01-01'))]:
        c.add(cid + '-overdue', 'isReviewOverdue', [x, T], review_overdue(x, T))
    for cid, x in [('soon-today', cl(next_review_due='2026-09-17')),
                   ('soon-30', cl(next_review_due='2026-10-17')),
                   ('soon-31', cl(next_review_due='2026-10-18')),
                   ('soon-past', cl(next_review_due='2026-09-16')),
                   ('soon-excluded', cl(applicability='Not applicable',
                                        next_review_due='2026-09-20'))]:
        c.add('review-' + cid, 'isReviewDueSoon', [x, T], review_due_soon(x, T))

    # --- ISO 19011 independence -------------------------------------------
    scope = [cl(id='c1', clause_ref='7.1.5', owner_id='u2'),
             cl(id='c2', clause_ref='8.5.1', owner_id='u9'),
             cl(id='c3', clause_ref='9.2', owner_id='u9')]
    for cid, a, s in [('indep-clear', au(lead_auditor_id='u7'), scope),
                      ('indep-owns-two', au(), scope),
                      ('indep-owns-one', au(), scope[:2]),
                      ('indep-external', au(lead_auditor_id=None, lead_auditor_name='LR'), scope),
                      ('indep-empty-scope', au(), []),
                      ('indep-owned-no-ref', au(), [{'id': 'c5', 'owner_id': 'u9'}]),
                      ('indep-null-entry', au(), [None, scope[0]])]:
        c.add(cid, 'auditIndependence', [a, s], audit_independence(a, s))
    c.add('indep-no-scope-arg', 'auditIndependence', [au()], audit_independence(au()))

    for cid, r in [('examined-conformant', cov()), ('examined-na', cov(result='Not applicable')),
                   ('examined-observation', cov(result='Observation')),
                   ('examined-not', cov(result='Not examined')), ('examined-unset', {})]:
        c.add(cid, 'isCoverageExamined', [r], examined(r))

    full = [cov(), cov(id='ac2', clause_id='c2', clause_ref='8.5.1', result='Nonconformant'),
            cov(id='ac3', clause_id='c3', clause_ref='8.3', result='Not applicable')]
    part = full[:2] + [cov(id='ac3', clause_id='c3', clause_ref='8.3', result='Not examined')]
    reports = [
        ('report-ok', au(), full),
        ('report-scope-incomplete', au(), part),
        ('report-empty-scope', au(), []),
        ('report-no-conclusion', au(conclusion='  '), full),
        ('report-external-lead', au(lead_auditor_id=None, lead_auditor_name='LR auditor'), full),
        ('report-no-lead', au(lead_auditor_id=None, lead_auditor_name=''), full),
        ('report-cancelled', au(status='Cancelled'), full),
        ('report-closed', au(status='Closed'), full),
    ]
    for cid, a, r in reports:
        c.add(cid, 'canReportAudit', [a, r], can_report_audit(a, r))

    closes = [
        ('close-audit-not-reported', au(), []),
        ('close-audit-ok', au(status='Reported'), [fi(finding_type=MINOR), fi(id='f2', status='Closed')]),
        ('close-audit-open-major', au(status='Reported'), [fi(status='Verification')]),
        ('close-audit-voided-major', au(status='Reported'), [fi(status='Voided')]),
        ('close-audit-already', au(status='Closed'), []),
    ]
    for cid, a, f in closes:
        c.add(cid, 'canCloseAudit', [a, f], can_close_audit(a, f))

    for s in AUDIT_STATUSES + ['Bogus']:
        c.add('next-audit-' + s.replace(' ', '-').lower(), 'nextAuditStatuses', [s],
              next_audit_statuses(s))
    adv = [
        ('advance-plan-start', au(status='Planned'), 'In progress', {}),
        ('advance-plan-report', au(status='Planned'), 'Reported', {'coverage': full}),
        ('advance-report-full', au(), 'Reported', {'coverage': full}),
        ('advance-report-partial', au(), 'Reported', {'coverage': part}),
        ('advance-report-nocontext', au(), 'Reported', {}),
        ('advance-close-major', au(status='Reported'), 'Closed', {'findings': [fi()]}),
        ('advance-close-ok', au(status='Reported'), 'Closed', {'findings': []}),
        ('advance-reopen-fieldwork', au(), 'In progress', {}),
        ('advance-reported-cancel', au(status='Reported'), 'Cancelled', {}),
        ('advance-closed-final', au(status='Closed'), 'Reported', {'coverage': full}),
    ]
    for cid, a, to, ctx in adv:
        c.add(cid, 'canAdvanceAudit', [a, to, ctx], can_advance_audit(a, to, ctx))

    for cid, a in [('audit-overdue-planned', au(status='Planned', planned_end='2026-09-16')),
                   ('audit-overdue-today', au(status='Planned', planned_end='2026-09-17')),
                   ('audit-overdue-reported', au(status='Reported', planned_end='2026-08-01')),
                   ('audit-overdue-closed', au(status='Closed', planned_end='2026-08-01')),
                   ('audit-overdue-cancelled', au(status='Cancelled', planned_end='2026-08-01')),
                   ('audit-overdue-nodate', au(status='In progress'))]:
        c.add(cid, 'isAuditOverdue', [a, T], audit_overdue(a, T))

    # --- findings ---------------------------------------------------------
    for s in ['Open', 'Correction proposed', 'Action in progress', 'Verification', 'Closed',
              'Voided']:
        c.add('finding-open-' + s.replace(' ', '-').lower(), 'isFindingOpen', [fi(status=s)],
              finding_open(fi(status=s)))
    for t in FINDING_TYPES:
        c.add('nonconformity-' + t.split()[0].lower(), 'isNonconformity', [fi(finding_type=t)],
              nonconformity(fi(finding_type=t)))
    for cid, f in [('finding-overdue-yes', fi(due_date='2026-09-10')),
                   ('finding-overdue-today', fi(due_date='2026-09-17')),
                   ('finding-overdue-closed', fi(due_date='2026-09-10', status='Closed')),
                   ('finding-overdue-voided', fi(due_date='2026-09-10', status='Voided')),
                   ('finding-overdue-nodate', fi())]:
        c.add(cid, 'isFindingOverdue', [f, T], finding_overdue(f, T))

    c.add('age-open', 'findingAgeDays', [fi(), T], finding_age(fi(), T))
    c.add('age-no-raise', 'findingAgeDays', [fi(raised_date=None), T], None)
    c.add('age-future-raise', 'findingAgeDays', [fi(raised_date='2026-09-20'), T], 0)
    c.add('age-closed-no-date', 'findingAgeDays', [fi(status='Closed'), T],
          finding_age(fi(status='Closed'), T))
    closed = fi(status='Closed', raised_date='2026-01-01', closed_date='2026-02-01')
    c.add('age-closed-stops-at-closure', 'findingAgeDays', [closed, T], finding_age(closed, T),
          defect='ISO-2')
    voided = fi(status='Voided', raised_date='2026-03-01', closed_date='2026-03-04')
    c.add('age-voided-stops', 'findingAgeDays', [voided, T], finding_age(voided, T),
          defect='ISO-2')

    # 10.2 closure
    cf = [
        ('close-closed', fi(status='Closed'), []),
        ('close-voided', fi(status='Voided'), []),
        ('close-minor-no-correction', fi(finding_type=MINOR), []),
        ('close-minor-blank-correction', fi(finding_type=MINOR, correction='  '), []),
        ('close-minor-corrected', fi(finding_type=MINOR, correction='Gauge recalibrated.'), []),
        ('close-minor-open-action', fi(finding_type=MINOR, correction='x'), [ac()]),
        ('close-observation', fi(finding_type='Observation'), []),
        ('close-ofi', fi(finding_type='Opportunity for improvement'), []),
        ('close-major-no-correction', fi(root_cause='x'), [ac(**VERIFIED)]),
        ('close-major-no-root-cause', fi(correction='x'), [ac(**VERIFIED)]),
        ('close-major-no-action', fi(correction='x', root_cause='No recall system'), []),
        ('close-major-only-preventive', fi(correction='x', root_cause='y'),
         [ac(**dict(VERIFIED, action_type='Preventive'))]),
        ('close-major-complete-unverified', fi(correction='x', root_cause='y'),
         [ac(status='Complete', completed_at='2026-09-10')]),
        ('close-major-failed', fi(correction='x', root_cause='y'),
         [ac(status='Complete', effectiveness_verified=False,
             effectiveness_checked_at='2026-09-12', effectiveness_verified_by='u3')]),
        ('close-major-failed-then-verified', fi(correction='x', root_cause='y'),
         [ac(status='Complete', effectiveness_verified=False,
             effectiveness_checked_at='2026-09-12', effectiveness_verified_by='u3'),
          ac(id='x2', **VERIFIED)]),
        ('close-major-verified', fi(correction='x', root_cause='y'), [ac(**VERIFIED)]),
        ('close-major-verified-cancelled', fi(correction='x', root_cause='y'),
         [ac(**dict(VERIFIED, status='Cancelled'))]),
        ('close-major-verified-unsigned', fi(correction='x', root_cause='y'),
         [ac(**dict(VERIFIED, effectiveness_verified_by=None))]),
        ('close-major-verified-plus-open', fi(correction='x', root_cause='y'),
         [ac(**VERIFIED), ac(id='x2', action_type='Preventive')]),
    ]
    for cid, f, a in cf:
        c.add(cid, 'canCloseFinding', [f, a], can_close_finding(f, a))
    c.add('close-no-actions-arg', 'canCloseFinding', [fi(finding_type='Observation')], allow())

    # --- coverage over the cycle -----------------------------------------
    clauses = [cl(id='c1', clause_ref='7.1.5'), cl(id='c2', clause_ref='8.5.1'),
               cl(id='c3', clause_ref='9.2'),
               cl(id='c4', clause_ref='8.3', applicability='Not applicable',
                  status='Not applicable', applicability_justification='no design')]
    audits = [au(id='a1', actual_end='2026-06-30'),
              au(id='a2', audit_type='Certification', audit_code='CB-2026'),
              au(id='a3', audit_code='IA-2023-004', actual_end='2023-09-20')]
    ac_rows = [
        cov(id='r1', audit_id='a1', clause_id='c1', examined_on='2023-09-17'),  # exactly at cutoff
        cov(id='r2', audit_id='a3', clause_id='c2', examined_on='2023-09-16'),  # one day before
        cov(id='r3', audit_id='a2', clause_id='c3', examined_on='2026-08-01'),  # CB audit
        cov(id='r4', audit_id='a1', clause_id='c4', examined_on='2026-08-01'),  # excluded clause
    ]
    data = {'clauses': clauses, 'auditClauses': ac_rows, 'audits': audits}
    c.add('coverage-boundary-day', 'clauseCoverage', [data, T], clause_coverage(data, T))
    rows2 = [
        cov(id='r1', audit_id='a1', clause_id='c1', examined_on='2024-02-02'),
        cov(id='r2', audit_id='a1', clause_id='c1', examined_on='2026-02-02', result='Observation'),
        cov(id='r3', audit_id='a1', clause_id='c1', examined_on='2026-05-05', result='Not examined'),
        cov(id='r4', audit_id='a1', clause_id='c2', examined_on=None),  # falls back to actual_end
        cov(id='r5', audit_id='a3', clause_id='c3', examined_on=None, result='Nonconformant'),
        cov(id='r6', audit_id='zz', clause_id='c3', examined_on='2026-09-01'),  # unknown audit
    ]
    d2 = {'clauses': clauses, 'auditClauses': rows2, 'audits': audits}
    c.add('coverage-latest-and-fallback', 'clauseCoverage', [d2, T], clause_coverage(d2, T))
    d3 = dict(d2, cycleYears=1)
    c.add('coverage-cycle-one-year', 'clauseCoverage', [d3, T], clause_coverage(d3, T))
    c.add('coverage-empty', 'clauseCoverage', [{}, T], [])
    c.add('coverage-only-excluded', 'clauseCoverage', [{'clauses': [clauses[3]]}, T], [])
    # 29 February: three years back is 28 Feb 2025 (ISO-3)
    leap = date('2028-02-29')
    dl = {'clauses': [cl(id='c1'), cl(id='c2', clause_ref='8.5.1')],
          'audits': [au()],
          'auditClauses': [cov(id='r1', clause_id='c1', examined_on='2025-02-28'),
                           cov(id='r2', clause_id='c2', examined_on='2025-02-27')]}
    c.add('coverage-leap-day-boundary', 'clauseCoverage', [dl, leap], clause_coverage(dl, leap),
          defect='ISO-3')
    dl2 = dict(dl, auditClauses=[cov(id='r1', clause_id='c1', examined_on='2025-03-01'),
                                 cov(id='r2', clause_id='c2', examined_on='2025-02-27')])
    c.add('coverage-leap-day-agreed', 'clauseCoverage', [dl2, leap], clause_coverage(dl2, leap))
    dl4 = dict(dl, cycleYears=4, auditClauses=[cov(id='r1', clause_id='c1', examined_on='2024-02-29'),
                                               cov(id='r2', clause_id='c2', examined_on='2024-02-28')])
    c.add('coverage-leap-to-leap', 'clauseCoverage', [dl4, leap], clause_coverage(dl4, leap))
    mar1 = date('2029-03-01')
    dm = dict(dl, auditClauses=[cov(id='r1', clause_id='c1', examined_on='2026-03-01'),
                                cov(id='r2', clause_id='c2', examined_on='2026-02-28')])
    c.add('coverage-march-first', 'clauseCoverage', [dm, mar1], clause_coverage(dm, mar1))

    # --- certification readiness ------------------------------------------
    good_clauses = [ev(id='c1'), ev(id='c2', clause_ref='8.5.1', status='Partially conformant'),
                    cl(id='c4', clause_ref='8.3', applicability='Not applicable',
                       status='Not applicable', applicability_justification='no design')]
    good_cov = [cov(id='r1', clause_id='c1'), cov(id='r2', clause_id='c2')]
    ready_data = {'clauses': good_clauses, 'auditClauses': good_cov, 'audits': [au()],
                  'findings': [fi(status='Closed')], 'actions': []}
    c.add('ready-clean', 'certificationReadiness', [std(), ready_data, T],
          certification_readiness(std(), ready_data, T))

    messy_clauses = [
        ev(id='c1'),                                                    # fine
        cl(id='c2', clause_ref='8.5.1', status='Conformant'),           # unevidenced claim
        cl(id='c3', clause_ref='9.2', status='Nonconformant', assessed_date='2026-05-01',
           assessed_by='u1', next_review_due='2026-09-01'),             # NC, review overdue
        cl(id='c5', clause_ref='7.2', next_review_due='2026-09-30'),    # never assessed
        cl(id='c6', clause_ref='7.5', standard_id='s2'),                # another standard
        cl(id='c4', clause_ref='8.3', applicability='Not applicable', status='Not applicable',
           applicability_justification='no design'),
    ]
    messy_cov = [cov(id='r1', clause_id='c1'),
                 cov(id='r2', audit_id='a3', clause_id='c2', examined_on='2022-05-05')]
    messy_find = [
        fi(id='f1'),                                                    # open major
        fi(id='f2', finding_type=MINOR, due_date='2026-09-01'),         # open minor, overdue
        fi(id='f3', finding_type=MINOR, status='Voided', due_date='2026-01-01'),
        fi(id='f4', standard_id='s2'),                                  # other standard
        fi(id='f5', finding_type='Observation', status='Verification'),
    ]
    messy_act = [ac(id='x1', finding_id='f1', due_date='2026-09-01'),
                 ac(id='x2', finding_id='f2', due_date='2026-09-30'),
                 ac(id='x3', finding_id='f4', due_date='2026-01-01'),  # other standard's finding
                 ac(id='x4', finding_id='f1', due_date='2026-01-01', status='Complete')]
    messy = {'clauses': messy_clauses, 'auditClauses': messy_cov,
             'audits': [au(), au(id='a3', actual_end='2022-05-10')],
             'findings': messy_find, 'actions': messy_act}
    s_exp = std(certificate_expires='2026-11-01')
    c.add('ready-messy', 'certificationReadiness', [s_exp, messy, T],
          certification_readiness(s_exp, messy, T))
    s_one = std(cycle_years=1, certificate_expires='2026-09-16')
    c.add('ready-one-year-cycle-expired', 'certificationReadiness', [s_one, ready_data, T],
          certification_readiness(s_one, ready_data, T))
    s_zero = std(cycle_years=0, certificate_expires=None)
    c.add('ready-cycle-zero-defaults', 'certificationReadiness', [s_zero, messy, T],
          certification_readiness(s_zero, messy, T))
    only_excl = {'clauses': [good_clauses[2]], 'findings': [fi()]}
    c.add('ready-no-applicable-clauses', 'certificationReadiness', [std(), only_excl, T],
          certification_readiness(std(), only_excl, T))
    c.add('ready-empty', 'certificationReadiness', [std(), {}, T],
          certification_readiness(std(), {}, T))
    c.add('ready-no-standard-id', 'certificationReadiness', [{'code': 'ISO 45001'}, messy, T],
          certification_readiness({'code': 'ISO 45001'}, messy, T))
    s90 = std(certificate_expires='2026-12-16')
    c.add('ready-cert-90-days', 'certificationReadiness', [s90, ready_data, T],
          certification_readiness(s90, ready_data, T))
    s91 = std(certificate_expires='2026-12-17')
    c.add('ready-cert-91-days', 'certificationReadiness', [s91, ready_data, T],
          certification_readiness(s91, ready_data, T))

    # --- summarise --------------------------------------------------------
    standards = [std(), std(id='s2', code='ISO 14001:2015', certification_status='Seeking certification')]
    sum_data = {
        'standards': standards,
        'clauses': messy_clauses + [cl(id='c7', clause_ref='6.1', next_review_due='2026-10-17'),
                                    cl(id='c8', clause_ref='6.2', next_review_due='2026-10-18')],
        'audits': [au(), au(id='a3', status='Closed', actual_end='2022-05-10'),
                   au(id='a4', status='Planned', planned_end='2026-09-01'),
                   au(id='a5', status='Reported', planned_end='2026-08-01'),
                   au(id='a6', status='Cancelled', planned_end='2026-08-01')],
        'findings': messy_find + [fi(id='f6', finding_type='Opportunity for improvement',
                                     status='Closed')],
        'actions': messy_act + [
            ac(id='x5', **VERIFIED),
            ac(id='x6', status='Complete', effectiveness_verified=False,
               effectiveness_checked_at='2026-09-12', effectiveness_verified_by='u3'),
            ac(id='x7', status='Cancelled', due_date='2026-01-01'),
        ],
        'auditClauses': messy_cov,
    }
    c.add('summary-mixed', 'summarise', [sum_data, T], summarise(sum_data, T))
    c.add('summary-empty', 'summarise', [{}, T], summarise({}, T))
    # a one-year cycle standard: the summary must agree with readiness (ISO-1)
    cyc = {'standards': [std(cycle_years=1)], 'clauses': [ev(id='c1'), ev(id='c2', clause_ref='8.5.1')],
           'audits': [au()],
           'auditClauses': [cov(id='r1', clause_id='c1', examined_on='2025-03-01'),
                            cov(id='r2', clause_id='c2', examined_on='2026-09-01')]}
    c.add('summary-honours-standard-cycle', 'summarise', [cyc, T], summarise(cyc, T), defect='ISO-1')
    c.add('ready-agrees-with-summary-cycle', 'certificationReadiness', [std(cycle_years=1), cyc, T],
          certification_readiness(std(cycle_years=1), cyc, T))
    cyc3 = dict(cyc, standards=[std()])
    c.add('summary-three-year-standard', 'summarise', [cyc3, T], summarise(cyc3, T))

    # --- countBy ----------------------------------------------------------
    rows = [{'dept': 'Ops'}, {'dept': 'QA'}, {'dept': 'QA'}, {'dept': None}, {'dept': ''},
            {'dept': 'Ops'}, {'x': 1}]
    c.add('countby-ties-and-unset', 'countBy', [rows, 'dept'], count_by(rows, 'dept'))
    c.add('countby-custom-unset', 'countBy', [rows, 'dept', 'None given'],
          count_by(rows, 'dept', 'None given'))
    c.add('countby-empty', 'countBy', [[], 'dept'], [])

    # --- sort -------------------------------------------------------------
    srows = [
        fi(id='closed', status='Closed', due_date='2026-01-01'),
        fi(id='minor-open-late', finding_type=MINOR, due_date='2026-09-10'),
        fi(id='major-open', due_date='2026-10-30'),
        fi(id='obs-open-undated', finding_type='Observation', raised_date=None),
        fi(id='major-late', due_date='2026-09-01'),
        fi(id='minor-open', finding_type=MINOR, due_date='2026-10-01'),
        fi(id='major-open-sooner', due_date='2026-10-01'),
        fi(id='obs-open-raised', finding_type='Observation', raised_date='2026-08-01'),
        fi(id='voided', status='Voided', due_date='2025-01-01'),
    ]
    c.sort('urgency-mixed', 'findingByUrgency', [T], srows, urgency_order(srows, T, iso_rank))
    return c


def main():
    c = build()
    doc = {
        'module': 'isoCompliance',
        'generatedBy': 'tools/validation/assurance/oracle_iso.py',
        'description': ('ISO Compliance (AS8) rules from the docstrings, AssuranceApps-STATUS.md '
                        '3g, ISO 9001:2015 4.3/9.2/10.2 and ISO 19011; independent stdlib model. '
                        'Dates as datetime.date; N years back clamps 29 Feb to 28 Feb.'),
        'cases': c.cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=1) + '\n')
    n = len(c.cases)
    k = sum(1 for x in c.cases if x.get('repaired'))
    print(f'{OUT.relative_to(ROOT)}: {n} cases, {k} repaired')


if __name__ == '__main__':
    main()
