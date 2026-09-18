#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/documentControl.js (AS12, group A).

Stdlib only. The rules, from the module's method statements and
AssuranceApps-STATUS.md section 3c (AS4):

  * reviewState: only a document IN FORCE (Published or Approved) can be
    due for review; anything else is 'Not in force'. In force with no
    review date: 'No review scheduled'. The review date passed (before
    today): 'Review overdue'; within 30 days, inclusive, of today
    (today itself included): 'Review due soon'; otherwise 'Review
    scheduled'. A review date that is not a readable calendar date is no
    review date (calendar.js: "an unreadable date is no date, never
    today"), so it reads 'No review scheduled'.
  * nextReviewDate: issue date + the review period in months, month-end
    clamped; no issue date or a period that is not a positive number:
    None. Counted from the issue date, never from today.
  * nextRevisionNumber: a revision is a run of digits; the next is +1,
    zero-padded to at least two digits and never narrower than the
    current one. Anything else starts the chain at '01'.
  * atLeastConfidential: position in Public < Internal < Confidential <
    Restricted, floor defaulting to Confidential; an unknown level or
    floor is never 'at least'.
  * summarise: total, a count per known status, inReview, published and
    the overdue / due-soon review counts.
  * byReviewUrgency: overdue, due soon, scheduled, not scheduled, not in
    force; within a state the earlier review date first, undated last.
  * documentPrefix: department and category, letters and digits only,
    upper-cased, first three characters; GEN and DOC when nothing is left.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oracle_calendar import (  # noqa: E402
    Cases, D, UNDEF, NAN, js_number, to_date, add_months, count_by, date_family_cases,
    date_key, truthy,
)

STATUSES = ['Draft', 'In Review', 'Approved', 'Published', 'Superseded', 'Obsolete', 'Rejected']
EFFECTIVE = ['Published', 'Approved']
LEVELS = ['Public', 'Internal', 'Confidential', 'Restricted']
OVERDUE, DUE_SOON, SCHEDULED = 'Review overdue', 'Review due soon', 'Review scheduled'
NOT_SCHEDULED, NOT_IN_FORCE = 'No review scheduled', 'Not in force'
ORDER = [OVERDUE, DUE_SOON, SCHEDULED, NOT_SCHEDULED, NOT_IN_FORCE]


def review_state(doc, today):
    if doc.get('status') not in EFFECTIVE:
        return NOT_IN_FORCE
    due = to_date(doc.get('next_review_date'))
    if due is None:
        return NOT_SCHEDULED
    days = (due - to_date(today)).days
    if days < 0:
        return OVERDUE
    return DUE_SOON if days <= 30 else SCHEDULED


def next_review(issue, months):
    d = to_date(issue)
    n = js_number(months)
    if d is None or n != n or n in (float('inf'), float('-inf')) or n <= 0:
        return None
    assert n == int(n), 'fractional periods are not asserted (see FINDINGS)'
    return add_months(d, int(n))


def next_revision(cur):
    s = '' if cur is None or cur is UNDEF else str(cur)
    s = s.strip()
    if not re.fullmatch(r'[0-9]+', s):
        return '01'
    return str(int(s) + 1).zfill(max(2, len(s)))


def at_least(level, floor='Confidential'):
    return level in LEVELS and floor in LEVELS and LEVELS.index(level) >= LEVELS.index(floor)


def summarise(docs, today):
    by = {s: 0 for s in STATUSES}
    for d in docs:
        if d.get('status') in by:
            by[d['status']] += 1
    states = [review_state(d, today) for d in docs]
    return {'total': len(docs), 'byStatus': by, 'inReview': by['In Review'], 'published': by['Published'],
            'overdue': states.count(OVERDUE), 'dueSoon': states.count(DUE_SOON)}


def prefix(dept, cat):
    def part(v, fb):
        s = re.sub(r'[^A-Za-z0-9]', '', str(v) if truthy(v) else '').upper()
        return s[:3] if s else fb
    return f"{part(dept, 'GEN')}-{part(cat, 'DOC')}"


def urgency_order(rows, today):
    return [r['id'] for r in sorted(rows, key=lambda r: (ORDER.index(review_state(r, today)),
                                                        date_key(to_date(r.get('next_review_date')))))]


def can_assign_reviewer(revision, reviewer):
    """AS15 D1: a reviewer must be named, and it is not the revision's author."""
    if not truthy(reviewer):
        return {'ok': False}
    author = (revision or {}).get('created_by')
    if truthy(author) and reviewer == author:
        return {'ok': False}
    return {'ok': True}


def can_decide_task(task, revision, user):
    """AS15 D1: only a pending task, only by its assigned reviewer, never by
    the revision's author (even if the author was assigned)."""
    task = task or {}
    status = task.get('status')
    if truthy(status) and status != 'Pending':
        return {'ok': False}
    if not truthy(user) or user != task.get('reviewer_id'):
        return {'ok': False}
    author = (revision or {}).get('created_by')
    if truthy(author) and user == author:
        return {'ok': False}
    return {'ok': True}


def build():
    c = Cases('documentControl', 'tools/validation/assurance/oracle_documents.py',
              'Controlled-document review state, review date, revision numbering, confidentiality, '
              'counts, sort and number prefix, from the method statements and STATUS section 3c.')
    T = D('2026-09-17')
    date_family_cases(c, 'cal', T)

    # reviewState: every status, every edge
    for s in STATUSES + ['published', 'Archived', None]:
        doc = {'status': s, 'next_review_date': '2026-01-01'}
        c.add(f'state-status-{s}', 'reviewState', [doc, T], review_state(doc, T))
    edges = {
        'state-no-date': {'status': 'Published'},
        'state-empty-date': {'status': 'Approved', 'next_review_date': ''},
        'state-yesterday': {'status': 'Published', 'next_review_date': '2026-09-16'},
        'state-today': {'status': 'Published', 'next_review_date': '2026-09-17'},
        'state-plus-30': {'status': 'Published', 'next_review_date': '2026-10-17'},
        'state-plus-31': {'status': 'Published', 'next_review_date': '2026-10-18'},
        'state-far': {'status': 'Approved', 'next_review_date': '2028-09-17'},
        'state-date-object-today': {'status': 'Approved', 'next_review_date': D('2026-09-17')},
    }
    for cid, doc in edges.items():
        c.add(cid, 'reviewState', [doc, T], review_state(doc, T))
    c.add('state-dst-us-edge', 'reviewState', [{'status': 'Published', 'next_review_date': '2026-04-07'},
                                               D('2026-03-08')], DUE_SOON)
    c.add('state-dst-us-edge-31', 'reviewState', [{'status': 'Published', 'next_review_date': '2026-04-08'},
                                                  D('2026-03-08')], SCHEDULED)
    c.add('state-dst-nz-edge', 'reviewState', [{'status': 'Published', 'next_review_date': '2026-05-05'},
                                               D('2026-04-05')], DUE_SOON)
    c.add('state-no-arg', 'reviewState', [UNDEF, T], NOT_IN_FORCE)
    # DC-1: an unreadable review date is no review date, not "due soon"
    c.add('state-garbage-date', 'reviewState', [{'status': 'Published', 'next_review_date': 'tbc'}, T],
          NOT_SCHEDULED, defect='DC-1')
    c.add('state-impossible-date', 'reviewState', [{'status': 'Published', 'next_review_date': '2026-02-30'},
                                                   T], NOT_SCHEDULED, defect='CAL-1')

    # isReviewOverdue
    for cid, doc in {
        'overdue-yes': {'status': 'Published', 'next_review_date': '2026-09-16'},
        'overdue-today': {'status': 'Published', 'next_review_date': '2026-09-17'},
        'overdue-not-in-force': {'status': 'Superseded', 'next_review_date': '2019-01-01'},
        'overdue-draft': {'status': 'Draft', 'next_review_date': '2019-01-01'},
        'overdue-no-date': {'status': 'Approved'},
    }.items():
        c.add(cid, 'isReviewOverdue', [doc, T], review_state(doc, T) == OVERDUE)
    c.add('overdue-undefined-doc', 'isReviewOverdue', [UNDEF, T], False)

    # nextReviewDate
    nr = [
        ('nrd-24', '2026-09-17', 24), ('nrd-12', '2026-09-17', 12), ('nrd-1', '2026-09-17', 1),
        ('nrd-jan31-1', '2026-01-31', 1), ('nrd-jan31-1-leap', '2028-01-31', 1),
        ('nrd-leapday-12', '2028-02-29', 12), ('nrd-leapday-48', '2028-02-29', 48),
        ('nrd-aug31-6', '2026-08-31', 6), ('nrd-may31-1', '2026-05-31', 1),
        ('nrd-dec-1', '2026-12-10', 1), ('nrd-36', '2026-03-08', 36), ('nrd-string-period', '2026-09-17', '24'),
        ('nrd-timestamp-issue', '2026-09-17T15:00:00Z', 24), ('nrd-date-object', D('2026-10-31'), 1),
    ]
    for cid, d, m in nr:
        c.add(cid, 'nextReviewDate', [d, m], next_review(d, m))
    for cid, d, m in [('nrd-zero', '2026-09-17', 0), ('nrd-negative', '2026-09-17', -12),
                      ('nrd-null-period', '2026-09-17', None), ('nrd-no-period', '2026-09-17', UNDEF),
                      ('nrd-text-period', '2026-09-17', 'two years'), ('nrd-nan', '2026-09-17', NAN),
                      ('nrd-no-issue', None, 24), ('nrd-garbage-issue', 'soon', 24)]:
        c.add(cid, 'nextReviewDate', [d, m], None)
    c.add('nrd-impossible-issue', 'nextReviewDate', ['2026-02-30', 12], None, defect='CAL-1')

    # nextRevisionNumber
    for cid, cur in {
        'rev-01': '01', 'rev-09': '09', 'rev-10': '10', 'rev-99': '99', 'rev-1': '1', 'rev-001': '001',
        'rev-099': '099', 'rev-999': '999', 'rev-00': '00', 'rev-padded-space': ' 07 ', 'rev-number': 3,
        'rev-zero': 0, 'rev-null': None, 'rev-undefined': UNDEF, 'rev-empty': '', 'rev-letter': 'A',
        'rev-prefixed': 'Rev 3', 'rev-decimal': '1.5', 'rev-negative': '-1', 'rev-v2': 'v2',
    }.items():
        c.add(cid, 'nextRevisionNumber', [cur], next_revision(cur))

    # atLeastConfidential
    for lv in LEVELS + ['Secret', None]:
        c.add(f'conf-default-{lv}', 'atLeastConfidential', [lv], at_least(lv))
    for lv in LEVELS:
        for fl in ['Public', 'Restricted']:
            c.add(f'conf-{lv}-vs-{fl}', 'atLeastConfidential', [lv, fl], at_least(lv, fl))
    c.add('conf-unknown-floor', 'atLeastConfidential', ['Restricted', 'Top secret'], False)
    c.add('conf-lowercase', 'atLeastConfidential', ['restricted'], False)

    # summarise
    docs = [
        {'status': 'Published', 'next_review_date': '2026-09-01'},
        {'status': 'Published', 'next_review_date': '2026-09-17'},
        {'status': 'Approved', 'next_review_date': '2026-10-17'},
        {'status': 'Approved', 'next_review_date': '2026-10-18'},
        {'status': 'Published'},
        {'status': 'In Review', 'next_review_date': '2020-01-01'},
        {'status': 'In Review'},
        {'status': 'Draft'},
        {'status': 'Superseded', 'next_review_date': '2019-01-01'},
        {'status': 'Obsolete'},
        {'status': 'Rejected'},
        {'status': 'Withdrawn'},
        {},
    ]
    c.add('summary-mixed', 'summarise', [docs, T], summarise(docs, T))
    c.add('summary-empty', 'summarise', [[], T], summarise([], T))
    c.add('summary-later-today', 'summarise', [docs, D('2026-10-18')], summarise(docs, D('2026-10-18')))

    # countBy
    rows = [{'department': 'HSE'}, {'department': 'Drilling'}, {'department': 'HSE'}, {'department': ''},
            {}, {'department': 'Drilling'}, {'department': 'Subsurface'}, {'department': 'Drilling'}]
    c.add('countby-dept', 'countBy', [rows, 'department'], count_by(rows, 'department'))
    c.add('countby-unset-label', 'countBy', [rows, 'department', 'None'], count_by(rows, 'department', 'None'))
    c.add('countby-empty', 'countBy', [[], 'department'], [])

    # byReviewUrgency
    srt = [
        {'id': 'draft', 'status': 'Draft', 'next_review_date': '2020-01-01'},
        {'id': 'sched-late', 'status': 'Published', 'next_review_date': '2028-01-01'},
        {'id': 'unscheduled', 'status': 'Published'},
        {'id': 'overdue-recent', 'status': 'Published', 'next_review_date': '2026-09-16'},
        {'id': 'soon-late', 'status': 'Approved', 'next_review_date': '2026-10-17'},
        {'id': 'sched-early', 'status': 'Approved', 'next_review_date': '2026-10-18'},
        {'id': 'overdue-old', 'status': 'Approved', 'next_review_date': '2025-01-01'},
        {'id': 'soon-today', 'status': 'Published', 'next_review_date': '2026-09-17'},
        {'id': 'superseded-undated', 'status': 'Superseded'},
        {'id': 'obsolete-dated', 'status': 'Obsolete', 'next_review_date': '2019-06-01'},
        {'id': 'unscheduled-2', 'status': 'Approved', 'next_review_date': ''},
    ]
    c.sort('urgency-mixed', 'byReviewUrgency', srt, urgency_order(srt, T), factory_args=[T])
    c.sort('urgency-empty', 'byReviewUrgency', [], [], factory_args=[T])

    # documentPrefix
    for cid, (dep, cat) in {
        'prefix-plain': ('HSE', 'Procedure'), 'prefix-spaces': ('Health & Safety', 'Work instruction'),
        'prefix-short': ('IT', 'SOP'), 'prefix-lower': ('drilling', 'policy'),
        'prefix-null-both': (None, None), 'prefix-empty': ('', ''), 'prefix-symbols-only': ('&-/', '***'),
        'prefix-digits': ('3D Seismic', '2024 plan'), 'prefix-accent': ('Géologie', 'Étude'),
        'prefix-one-char': ('X', 'y'), 'prefix-null-dept': (None, 'Drawing'),
    }.items():
        c.add(cid, 'documentPrefix', [dep, cat], prefix(dep, cat))

    # AS15 D1: segregation of duties on review tasks
    rev = {'created_by': 'u-author'}
    for tag, who in [('independent', 'u-rev'), ('author', 'u-author'), ('nobody', None), ('empty', '')]:
        c.add(f'assign-reviewer-{tag}', 'canAssignReviewer', [rev, who],
              can_assign_reviewer(rev, who), 'AS15-D1')
    c.add('assign-reviewer-author-unknown', 'canAssignReviewer', [{}, 'u-rev'],
          can_assign_reviewer({}, 'u-rev'))
    task = {'reviewer_id': 'u-rev', 'status': 'Pending'}
    for tag, t, r, who in [
        ('assignee', task, rev, 'u-rev'),
        ('non-assignee', task, rev, 'u-other'),
        ('not-signed-in', task, rev, None),
        ('author-not-assigned', task, rev, 'u-author'),
        ('author-who-is-assignee', dict(task, reviewer_id='u-author'), rev, 'u-author'),
        ('already-approved', dict(task, status='Approved'), rev, 'u-rev'),
        ('closed-by-round', dict(task, status='Closed'), rev, 'u-rev'),
        ('no-status-is-pending', {'reviewer_id': 'u-rev'}, rev, 'u-rev'),
        ('author-unknown', task, {}, 'u-rev'),
    ]:
        c.add(f'decide-task-{tag}', 'canDecideReviewTask', [t, r, who],
              can_decide_task(t, r, who), 'AS15-D1')
    return c


if __name__ == '__main__':
    build().write('documentControl_cases.json')
