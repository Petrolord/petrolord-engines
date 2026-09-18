#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/peerReview.js (AS12, group A).

Stdlib only. The rules, from the module's method statements and
AssuranceApps-STATUS.md section 3d (AS5):

  * Comment disposition: Open -> Responded | Withdrawn; Responded ->
    Verified | Rejected; Rejected -> back to the author (Responded) or
    Withdrawn; Verified -> Closed; Closed and Withdrawn are final. A
    comment with no status is Open. Verified additionally needs a
    non-blank response to verify.
  * Resolved = Verified, Closed or Withdrawn. Blocking = Critical or Major
    and not resolved. A review may close only with no blocking comment;
    the refusal lists the blocking comments (in the order given).
  * Review stages: Draft -> In Review | Cancelled; In Review ->
    Verification | Draft | Cancelled; Verification -> Closed | In Review |
    Cancelled; Closed and Cancelled are final.
  * A review is overdue only while live (Draft, In Review, Verification)
    and only when its due date (a calendar date) is before today.
  * summarise counts reviews by stage, active, overdue, comments by
    severity and by status, open (unresolved) and blocking comments.
  * byUrgency: overdue first, then the other live reviews, then closed or
    cancelled; within a rank the earlier due date first, undated last.
  * bySeverityThenAge: unresolved before resolved, then worst severity
    first (Critical, Major, Minor, Editorial; a comment with no
    recognised severity is not worse than Critical, so it goes after
    Editorial), then oldest first by created_at.

explainRefusal returns a bare string, which the golden runner compares
verbatim (only the reason/text/message KEYS of objects are prose-exempt).
Its sentences are therefore taken from the code; what the oracle decides
independently is WHICH refusal applies and the English article.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oracle_calendar import (  # noqa: E402
    Cases, D, UNDEF, to_date, count_by, date_family_cases, date_key, truthy,
)

STAGES = ['Draft', 'In Review', 'Verification', 'Closed', 'Cancelled']
ACTIVE = ['Draft', 'In Review', 'Verification']
SEVERITIES = ['Critical', 'Major', 'Minor', 'Editorial']
BLOCKING = ['Critical', 'Major']
STATUSES = ['Open', 'Responded', 'Verified', 'Closed', 'Rejected', 'Withdrawn']
RESOLVED = ['Verified', 'Closed', 'Withdrawn']
DISPOSITION = {
    'Open': ['Responded', 'Withdrawn'],
    'Responded': ['Verified', 'Rejected'],
    'Rejected': ['Responded', 'Withdrawn'],
    'Verified': ['Closed'],
    'Closed': [],
    'Withdrawn': [],
}
STAGE_MOVES = {
    'Draft': ['In Review', 'Cancelled'],
    'In Review': ['Verification', 'Draft', 'Cancelled'],
    'Verification': ['Closed', 'In Review', 'Cancelled'],
    'Closed': [],
    'Cancelled': [],
}


def can(frm, to):
    return to in DISPOSITION.get(frm, [])


def article(word):
    return 'An' if word[:1].lower() in 'aeiou' else 'A'


def refusal(comment, to):
    frm = comment.get('status') or 'Open'
    if can(frm, to):
        if to == 'Verified' and not str(comment.get('response_text') or '').strip():
            return 'A comment cannot be verified before the author has responded to it.'
        return None
    if frm == to:
        return f'This comment is already {to.lower()}.'
    allowed = DISPOSITION.get(frm, [])
    if not allowed:
        return f'{article(frm)} {frm.lower()} comment is final.'
    return f'{article(frm)} {frm.lower()} comment can only go to {" or ".join(allowed)}.'


def resolved(c):
    return c.get('status') in RESOLVED


def blocking(c):
    return c.get('severity') in BLOCKING and not resolved(c)


def can_close(comments):
    b = [c for c in comments if blocking(c)]
    return {'ok': True, 'blocking': []} if not b else {'ok': False, 'blocking': b}


def overdue(r, today):
    if r.get('stage') not in ACTIVE:
        return False
    d = to_date(r.get('due_date'))
    return d is not None and d < to_date(today)


def summarise(reviews, comments, today):
    return {
        'total': len(reviews),
        'byStage': {s: sum(1 for r in reviews if r.get('stage') == s) for s in STAGES},
        'active': sum(1 for r in reviews if r.get('stage') in ACTIVE),
        'overdue': sum(1 for r in reviews if overdue(r, today)),
        'totalComments': len(comments),
        'bySeverity': {s: sum(1 for c in comments if c.get('severity') == s) for s in SEVERITIES},
        'byStatus': {s: sum(1 for c in comments if c.get('status') == s) for s in STATUSES},
        'openComments': sum(1 for c in comments if not resolved(c)),
        'blockingComments': sum(1 for c in comments if blocking(c)),
    }


def urgency_order(rows, today):
    def rank(r):
        if overdue(r, today):
            return 0
        return 1 if r.get('stage') in ACTIVE else 2
    return [r['id'] for r in sorted(rows, key=lambda r: (rank(r), date_key(to_date(r.get('due_date')))))]


def severity_order(rows):
    def sev(c):
        s = c.get('severity')
        return SEVERITIES.index(s) if s in SEVERITIES else len(SEVERITIES)
    return [c['id'] for c in sorted(rows, key=lambda c: (resolved(c), sev(c), str(c.get('created_at') or '')))]


def build():
    c = Cases('peerReview', 'tools/validation/assurance/oracle_peer_review.py',
              'Peer review comment disposition, close gate, stages, overdue, counts and sorts, '
              'from the method statements and STATUS section 3d.')
    T = D('2026-09-17')
    date_family_cases(c, 'cal', T)

    # canTransition: the whole 6x6 grid, plus unknowns
    for f in STATUSES:
        for t in STATUSES:
            c.add(f'can-{f}-{t}', 'canTransition', [f, t], can(f, t))
    c.add('can-unknown-from', 'canTransition', ['Pending', 'Responded'], False)
    c.add('can-unknown-to', 'canTransition', ['Open', 'Answered'], False)
    c.add('can-undefined-from', 'canTransition', [UNDEF, 'Responded'], False)
    c.add('can-lowercase', 'canTransition', ['open', 'responded'], False)

    # nextStatuses
    for f in STATUSES + ['Pending']:
        c.add(f'next-{f}', 'nextStatuses', [f], DISPOSITION.get(f, []))
    c.add('next-undefined', 'nextStatuses', [UNDEF], [])

    # explainRefusal
    plain = [
        ('refuse-open-respond', {'status': 'Open'}, 'Responded'),
        ('refuse-open-withdraw', {'status': 'Open'}, 'Withdrawn'),
        ('refuse-nostatus-respond', {}, 'Responded'),
        ('refuse-responded-verify-with-text', {'status': 'Responded', 'response_text': 'Revised the model.'}, 'Verified'),
        ('refuse-responded-verify-no-text', {'status': 'Responded'}, 'Verified'),
        ('refuse-responded-verify-blank', {'status': 'Responded', 'response_text': '   '}, 'Verified'),
        ('refuse-responded-reject', {'status': 'Responded'}, 'Rejected'),
        ('refuse-rejected-respond', {'status': 'Rejected'}, 'Responded'),
        ('refuse-rejected-withdraw', {'status': 'Rejected'}, 'Withdrawn'),
        ('refuse-verified-close', {'status': 'Verified', 'response_text': 'ok'}, 'Closed'),
        ('refuse-same-responded', {'status': 'Responded'}, 'Responded'),
        ('refuse-same-closed', {'status': 'Closed'}, 'Closed'),
        ('refuse-same-open', {'status': 'Open'}, 'Open'),
        ('refuse-closed-final', {'status': 'Closed'}, 'Open'),
        ('refuse-withdrawn-final', {'status': 'Withdrawn'}, 'Responded'),
        ('refuse-responded-close', {'status': 'Responded'}, 'Closed'),
        ('refuse-verified-reopen', {'status': 'Verified'}, 'Open'),
        ('refuse-rejected-verify', {'status': 'Rejected', 'response_text': 'x'}, 'Verified'),
        ('refuse-unknown-from', {'status': 'Pending'}, 'Responded'),
    ]
    for cid, com, to in plain:
        c.add(cid, 'explainRefusal', [com, to], refusal(com, to))
    # PR-2: the only status beginning with a vowel is Open, and the engine
    # writes "A open comment ..." in a sentence shown to the user.
    for cid, com, to in [('refuse-open-verify', {'status': 'Open'}, 'Verified'),
                         ('refuse-open-close', {'status': 'Open'}, 'Closed'),
                         ('refuse-nostatus-verify', {}, 'Verified')]:
        c.add(cid, 'explainRefusal', [com, to], refusal(com, to), defect='PR-2')

    # isResolved / isBlocking
    for s in STATUSES + [None]:
        c.add(f'resolved-{s}', 'isResolved', [{'status': s}], resolved({'status': s}))
    c.add('resolved-no-arg', 'isResolved', [], False)
    for sev in SEVERITIES + [None]:
        for s in ['Open', 'Rejected', 'Responded', 'Verified', 'Withdrawn']:
            com = {'severity': sev, 'status': s}
            c.add(f'blocking-{sev}-{s}', 'isBlocking', [com], blocking(com))
    c.add('blocking-no-arg', 'isBlocking', [], False)

    # canClose
    cc = {
        'close-empty': [],
        'close-minor-open': [{'id': 1, 'severity': 'Minor', 'status': 'Open'},
                             {'id': 2, 'severity': 'Editorial', 'status': 'Rejected'}],
        'close-all-resolved': [{'id': 1, 'severity': 'Critical', 'status': 'Closed'},
                               {'id': 2, 'severity': 'Major', 'status': 'Verified'},
                               {'id': 3, 'severity': 'Critical', 'status': 'Withdrawn'}],
        'close-one-critical': [{'id': 1, 'severity': 'Critical', 'status': 'Open'},
                               {'id': 2, 'severity': 'Minor', 'status': 'Open'}],
        'close-one-major-responded': [{'id': 1, 'severity': 'Major', 'status': 'Responded'}],
        'close-mixed': [{'id': 1, 'severity': 'Major', 'status': 'Open'},
                        {'id': 2, 'severity': 'Critical', 'status': 'Rejected'},
                        {'id': 3, 'severity': 'Critical', 'status': 'Verified'},
                        {'id': 4, 'severity': 'Major', 'status': 'Responded'},
                        {'id': 5, 'severity': 'Critical', 'status': 'Open'}],
    }
    for cid, coms in cc.items():
        c.add(cid, 'canClose', [coms], can_close(coms))
    c.add('close-no-arg', 'canClose', [], {'ok': True, 'blocking': []})

    # nextStages
    for s in STAGES + ['Archived']:
        c.add(f'stage-{s}', 'nextStages', [s], STAGE_MOVES.get(s, []))

    # isOverdue
    for s in STAGES + [None]:
        r = {'stage': s, 'due_date': '2026-09-16'}
        c.add(f'overdue-stage-{s}', 'isOverdue', [r, T], overdue(r, T))
    for cid, r in {
        'overdue-due-today': {'stage': 'In Review', 'due_date': '2026-09-17'},
        'overdue-due-tomorrow': {'stage': 'In Review', 'due_date': '2026-09-18'},
        'overdue-no-date': {'stage': 'In Review'},
        'overdue-garbage-date': {'stage': 'Draft', 'due_date': 'asap'},
        'overdue-date-object': {'stage': 'Verification', 'due_date': D('2026-09-16')},
        'overdue-date-object-today': {'stage': 'Verification', 'due_date': D('2026-09-17')},
    }.items():
        c.add(cid, 'isOverdue', [r, T], overdue(r, T))
    c.add('overdue-across-dst', 'isOverdue', [{'stage': 'Draft', 'due_date': '2026-11-01'}, D('2026-11-02')], True)
    c.add('overdue-no-arg', 'isOverdue', [UNDEF, T], False)
    c.add('overdue-impossible-date', 'isOverdue', [{'stage': 'In Review', 'due_date': '2026-02-30'}, T],
          False, defect='CAL-1')

    # summarise
    reviews = [
        {'stage': 'Draft', 'due_date': '2026-09-01'},
        {'stage': 'In Review', 'due_date': '2026-09-17'},
        {'stage': 'In Review', 'due_date': '2026-08-01'},
        {'stage': 'Verification'},
        {'stage': 'Closed', 'due_date': '2025-01-01'},
        {'stage': 'Cancelled', 'due_date': '2025-01-01'},
        {'stage': 'On hold', 'due_date': '2025-01-01'},
        {},
    ]
    comments = [
        {'severity': 'Critical', 'status': 'Open'},
        {'severity': 'Critical', 'status': 'Closed'},
        {'severity': 'Major', 'status': 'Responded'},
        {'severity': 'Major', 'status': 'Verified'},
        {'severity': 'Minor', 'status': 'Open'},
        {'severity': 'Editorial', 'status': 'Withdrawn'},
        {'severity': 'Minor', 'status': 'Rejected'},
        {'severity': None, 'status': 'Open'},
        {'severity': 'Major', 'status': 'Rejected'},
        {'severity': 'Trivial', 'status': 'Acknowledged'},
    ]
    c.add('summary-mixed', 'summarise', [reviews, comments, T], summarise(reviews, comments, T))
    c.add('summary-empty', 'summarise', [[], [], T], summarise([], [], T))
    c.add('summary-reviews-only', 'summarise', [reviews, [], D('2026-10-01')], summarise(reviews, [], D('2026-10-01')))

    # countBy
    rows = [{'discipline': 'Reservoir'}, {'discipline': 'Drilling'}, {'discipline': 'Reservoir'},
            {'discipline': None}, {}, {'discipline': 'Facilities'}]
    c.add('countby-discipline', 'countBy', [rows, 'discipline'], count_by(rows, 'discipline'))
    c.add('countby-unset-label', 'countBy', [rows, 'discipline', 'General'], count_by(rows, 'discipline', 'General'))
    c.add('countby-empty', 'countBy', [[], 'discipline'], [])

    # byUrgency
    srt = [
        {'id': 'closed-old', 'stage': 'Closed', 'due_date': '2025-01-01'},
        {'id': 'live-late', 'stage': 'In Review', 'due_date': '2027-01-01'},
        {'id': 'overdue-recent', 'stage': 'Draft', 'due_date': '2026-09-16'},
        {'id': 'live-undated', 'stage': 'Verification'},
        {'id': 'live-today', 'stage': 'In Review', 'due_date': '2026-09-17'},
        {'id': 'overdue-old', 'stage': 'Verification', 'due_date': '2026-01-01'},
        {'id': 'cancelled-undated', 'stage': 'Cancelled'},
        {'id': 'cancelled-dated', 'stage': 'Cancelled', 'due_date': '2024-01-01'},
    ]
    c.sort('urgency-mixed', 'byUrgency', srt, urgency_order(srt, T), factory_args=[T])
    c.sort('urgency-empty', 'byUrgency', [], [], factory_args=[T])

    # bySeverityThenAge
    coms = [
        {'id': 'minor-open-old', 'severity': 'Minor', 'status': 'Open', 'created_at': '2026-09-01T10:00:00Z'},
        {'id': 'crit-closed', 'severity': 'Critical', 'status': 'Closed', 'created_at': '2026-08-01T10:00:00Z'},
        {'id': 'major-open-new', 'severity': 'Major', 'status': 'Open', 'created_at': '2026-09-10T10:00:00Z'},
        {'id': 'crit-open', 'severity': 'Critical', 'status': 'Responded', 'created_at': '2026-09-12T10:00:00Z'},
        {'id': 'major-open-old', 'severity': 'Major', 'status': 'Rejected', 'created_at': '2026-09-02T10:00:00Z'},
        {'id': 'edit-open', 'severity': 'Editorial', 'status': 'Open', 'created_at': '2026-07-01T10:00:00Z'},
        {'id': 'major-verified', 'severity': 'Major', 'status': 'Verified', 'created_at': '2026-09-03T10:00:00Z'},
        {'id': 'major-open-undated', 'severity': 'Major', 'status': 'Open'},
    ]
    c.sort('sev-mixed', 'bySeverityThenAge', coms, severity_order(coms))
    c.sort('sev-empty', 'bySeverityThenAge', [], [])
    with_unknown = coms + [
        {'id': 'unrated-open', 'severity': None, 'status': 'Open', 'created_at': '2026-09-05T10:00:00Z'},
    ]
    c.sort('sev-unrated-not-above-critical', 'bySeverityThenAge', with_unknown, severity_order(with_unknown),
           defect='PR-1')
    return c


if __name__ == '__main__':
    build().write('peerReview_cases.json')
