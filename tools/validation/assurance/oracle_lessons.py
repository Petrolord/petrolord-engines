#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/lessonsLearned.js (AS12).

Written from the METHOD STATEMENTS, not from the JavaScript:
  - the module docstrings (an author may not validate their own lesson;
    an anecdote is not a lesson: what happened, why, and what to do; a
    lesson that was never applied has not been learned, and Embedded is
    earned by an Adopted or Adapted application, never by a Rejected one;
    reusability is counted, not claimed);
  - docs/scope/AssuranceApps-STATUS.md section 3h (AS9): a Draft needs no
    substance, an external validator named in text is not blocked,
    archiving needs a written reason, the two Suite targets carry real keys;
  - calendar.js: a 'YYYY-MM-DD' is a calendar date at local midnight, an
    unreadable date is no date. Python's datetime.date is the model.

Rules taken from the code rather than the docs are listed in
FINDINGS-lessons.md. Stdlib only.
Run:  python3 tools/validation/assurance/oracle_lessons.py
"""
import datetime as dt
import functools
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'assurance', 'goldens',
                   'lessonsLearned_cases.json')

# ---------------------------------------------------------------- values


def D(s):
    return {'$date': s}


UNDEF = {'$undefined': True}
INVALID_DATE = {'$date': None}


def is_undef(v):
    return isinstance(v, dict) and v.get('$undefined') is True


def js_truthy(v):
    if v is None or v is False or is_undef(v):
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0
    if isinstance(v, str):
        return v != ''
    return True


def js_string(v):
    if isinstance(v, list):
        return ','.join('' if x is None else js_string(x) for x in v)
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


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
    return None if is_undef(v) else v


def blank(v):
    return not js_truthy(v) or (isinstance(v, str) and not v.strip())


def arg(v, default):
    return default if v is None or is_undef(v) else v

# ---------------------------------------------------------------- vocabularies


STATUSES = ['Draft', 'Submitted', 'Validated', 'Published', 'Embedded', 'Archived', 'Superseded']
LIVE = STATUSES[:5]
ACCEPTED = ['Validated', 'Published', 'Embedded']
VISIBLE = ['Published', 'Embedded']
TARGETS = ['Risk register', 'Management of change', 'Procedure', 'Training',
           'Design standard', 'Contract or tender', 'Maintenance plan', 'Other']
SUITE_TARGETS = ['Risk register', 'Management of change']
OUTCOMES = ['Adopted', 'Adapted', 'Rejected']
CHANGED = ['Adopted', 'Adapted']
REVIEW_LEAD = 30

# The workflow edges are not in the docs; taken from the code (R1). What
# the docs fix, and the cases check: Archived and Superseded are final,
# and Embedded is reached only from Published.
EDGES = {
    'Draft': ['Submitted', 'Archived'],
    'Submitted': ['Validated', 'Draft', 'Archived'],
    'Validated': ['Published', 'Submitted', 'Archived'],
    'Published': ['Embedded', 'Superseded', 'Archived'],
    'Embedded': ['Superseded', 'Archived'],
    'Archived': [], 'Superseded': [],
}

# The searchable text of a lesson (field list taken from the code, R2).
SEARCH_FIELDS = ['lesson_code', 'title', 'description', 'root_cause', 'recommendation',
                 'consequence', 'category', 'discipline', 'department', 'project_ref', 'asset_id',
                 'keywords', 'source_reference', 'author_name']

# ---------------------------------------------------------------- the lesson


def o_is_live(l):
    return get(l or {}, 'status') in LIVE


def o_is_visible(l):
    return get(l or {}, 'status') in VISIBLE


def o_is_accepted(l):
    return get(l or {}, 'status') in ACCEPTED


def o_missing(l):
    l = l or {}
    out = []
    if blank(get(l, 'description')):
        out.append('what happened')
    if blank(get(l, 'root_cause')):
        out.append('why it happened')
    if blank(get(l, 'recommendation')):
        out.append('what to do about it')
    return out


def o_has_substance(l):
    return not o_missing(l)


def o_has_validation(l):
    l = l or {}
    return js_truthy(get(l, 'validated_at')) and (
        js_truthy(get(l, 'validated_by')) or not blank(get(l, 'validator_name')))


def o_can_validate(lesson, validator_id=None, patch=None):
    nxt = dict(lesson or {})
    nxt.update(arg(patch, {}))
    author = get(nxt, 'author_id') if js_truthy(get(nxt, 'author_id')) else get(nxt, 'created_by')
    if js_truthy(validator_id) and js_truthy(author) and validator_id == author:
        return {'ok': False}
    if not o_has_substance(nxt):
        return {'ok': False}
    return {'ok': True}

# ---------------------------------------------------------------- applications


def o_changed(a):
    return get(a or {}, 'outcome') in CHANGED


def o_reuse(apps):
    applied = [a for a in apps if o_changed(a)]
    targets = []
    for a in applied:
        t = get(a, 'target_type')
        if js_truthy(t) and t not in targets:
            targets.append(t)
    dates = [d for d in (cal_date(get(a, 'applied_on')) for a in applied) if d]
    return {
        'total': len(apps),
        'applied': len(applied),
        'adopted': sum(1 for a in apps if get(a, 'outcome') == 'Adopted'),
        'adapted': sum(1 for a in apps if get(a, 'outcome') == 'Adapted'),
        'rejected': sum(1 for a in apps if get(a, 'outcome') == 'Rejected'),
        'targets': targets,
        'lastAppliedOn': max(dates).isoformat() if dates else None,
    }


def o_can_record(a):
    a = a or {}
    t = get(a, 'target_type')
    if t not in TARGETS:
        return {'ok': False}
    if t == 'Risk register' and not js_truthy(get(a, 'target_risk_id')):
        return {'ok': False}
    if t == 'Management of change' and not js_truthy(get(a, 'target_moc_id')):
        return {'ok': False}
    if t not in SUITE_TARGETS and blank(get(a, 'reference')):
        return {'ok': False}
    if get(a, 'outcome') not in OUTCOMES:
        return {'ok': False}
    if get(a, 'outcome') == 'Rejected' and blank(get(a, 'notes')):
        return {'ok': False}
    return {'ok': True}

# ---------------------------------------------------------------- workflow


def o_next(status):
    return list(EDGES.get(status, [])) if isinstance(status, str) else []


def o_can_embed(lesson, apps=None):
    return {'ok': o_reuse(arg(apps, []))['applied'] > 0}


def patched(lesson, patch, key):
    p = arg(patch, {})
    v = get(p, key)
    return v if v is not None else get(lesson or {}, key)


def o_can_archive(lesson, patch=None):
    return {'ok': not blank(patched(lesson, patch, 'archive_reason'))}


def o_can_supersede(lesson, patch=None):
    succ = patched(lesson, patch, 'superseded_by')
    if not js_truthy(succ):
        return {'ok': False}
    if succ == get(lesson or {}, 'id'):
        return {'ok': False}
    return {'ok': True}


def o_can_advance(lesson, to, ctx=None):
    lesson = lesson or {}
    ctx = arg(ctx, {})
    if to not in o_next(get(lesson, 'status')):
        return {'ok': False}
    if to == 'Validated':
        return o_can_validate(lesson, ctx.get('validatorId'), ctx.get('patch'))
    if to == 'Published':
        return {'ok': o_has_substance(lesson) and o_has_validation(lesson)}
    if to == 'Embedded':
        return o_can_embed(lesson, ctx.get('applications'))
    if to == 'Archived':
        return o_can_archive(lesson, ctx.get('patch'))
    if to == 'Superseded':
        return o_can_supersede(lesson, ctx.get('patch'))
    return {'ok': True}

# ---------------------------------------------------------------- dates


def o_review_overdue(l, today):
    if not o_is_visible(l):
        return False
    d = days_until(get(l, 'review_due'), today)
    return d is not None and d < 0


def o_review_soon(l, today):
    if not o_is_visible(l):
        return False
    d = days_until(get(l, 'review_due'), today)
    return d is not None and 0 <= d <= REVIEW_LEAD


def event_of(l):
    e = get(l, 'event_date')
    return cal_date(e if js_truthy(e) else get(l, 'created_at'))


def o_age(l, today):
    e = event_of(l or {})
    if e is None:
        return None
    return max(0, (cal_date(today) - e).days)


def o_unapplied(l, apps=None):
    return o_is_visible(l) and o_reuse(arg(apps, []))['applied'] == 0

# ---------------------------------------------------------------- search


def o_search(lessons, query='', filters=None):
    filters = arg(filters, {})
    terms = js_string(query).lower().split() if js_truthy(query) else []
    fmap = [('status', 'status'), ('category', 'category'), ('discipline', 'discipline'),
            ('source_type', 'source_type'), ('scope', 'applicability_scope')]
    out = []
    for l in lessons:
        if any(js_truthy(filters.get(f)) and get(l, col) != filters.get(f) for f, col in fmap):
            continue
        if js_truthy(filters.get('visibleOnly')) and not o_is_visible(l):
            continue
        hay = ' '.join(js_string(get(l, f)) for f in SEARCH_FIELDS if js_truthy(get(l, f))).lower()
        if all(t in hay for t in terms):
            out.append(l)
    return out

# ---------------------------------------------------------------- summaries


def o_summarise(data, today):
    data = arg(data, {})
    lessons = data.get('lessons') or []
    apps = data.get('applications') or []
    visible = [l for l in lessons if o_is_visible(l)]
    unapplied = [l for l in visible
                 if not any(get(a, 'lesson_id') == get(l, 'id') and o_changed(a) for a in apps)]
    applied = [a for a in apps if o_changed(a)]
    return {
        'lessons': len(lessons),
        'byStatus': {s: sum(1 for l in lessons if get(l, 'status') == s) for s in STATUSES},
        'live': sum(1 for l in lessons if o_is_live(l)),
        'visible': len(visible),
        'awaitingValidation': sum(1 for l in lessons if get(l, 'status') == 'Submitted'),
        'drafts': sum(1 for l in lessons if get(l, 'status') == 'Draft'),
        'applications': len(apps),
        'applied': len(applied),
        'rejected': sum(1 for a in apps if get(a, 'outcome') == 'Rejected'),
        'lessonsApplied': len(visible) - len(unapplied),
        'lessonsUnapplied': len(unapplied),
        'intoRiskRegister': sum(1 for a in applied if get(a, 'target_type') == 'Risk register'),
        'intoMoc': sum(1 for a in applied if get(a, 'target_type') == 'Management of change'),
        'reviewsOverdue': sum(1 for l in lessons if o_review_overdue(l, today)),
        'reviewsDueSoon': sum(1 for l in lessons if o_review_soon(l, today)),
    }


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


def attention_order(rows, apps_by_lesson, today):
    """Published-and-never-applied first (they are the work), then awaiting
    validation, then review overdue, then live, then finished. Within a rank
    the most recent event first; a lesson with no date sorts after the dated
    ones, as in the module's two sibling comparators."""
    def rank(l):
        if o_unapplied(l, apps_by_lesson.get(get(l, 'id'), [])):
            return 0
        if get(l, 'status') == 'Submitted':
            return 1
        if o_review_overdue(l, today):
            return 2
        if o_is_live(l):
            return 3
        return 4

    def cmp(a, b):
        if rank(a) != rank(b):
            return rank(a) - rank(b)
        da, db = event_of(a), event_of(b)
        if da and db:
            return (db - da).days
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
for cid, v in [('parse-plain', '2026-09-18'), ('parse-ts', '2026-09-18T00:00:00-05:00'),
               ('parse-date', D('2026-03-29')), ('parse-null', None), ('parse-garbage', '18/09/2026'),
               ('parse-invalid-date', INVALID_DATE)]:
    case(cid, 'parseDateOnly', [v], out_date(cal_date(v)))
case('parse-31-june', 'parseDateOnly', ['2026-06-31'], None, 'CAL-1')
for cid, v, t in [('days-future', iso(30), T), ('days-past', iso(-1), T), ('days-null', None, T),
                  ('days-dst-eu-end', '2026-10-26', D('2026-10-24'))]:
    case(cid, 'daysUntil', [v, t], days_until(v, t))
for cid, v in [('tods-date', D('2026-11-01')), ('tods-str', '2026-11-01T12:00Z'), ('tods-null', None)]:
    d = cal_date(v)
    case(cid, 'toDateOnlyString', [v], None if d is None else d.isoformat())

# --- status predicates, every status
for st in STATUSES + ['Rejected', None]:
    for fn, o in [('isLive', o_is_live), ('isVisible', o_is_visible), ('isAccepted', o_is_accepted)]:
        case(f'{fn}-{st}', fn, [{'status': st}], o({'status': st}))
for fn in ['isLive', 'isVisible', 'isAccepted']:
    case(f'{fn}-default', fn, [UNDEF], False)

# --- substance
FULL = {'description': 'Seal failed on restart', 'root_cause': 'Dry running at start-up',
        'recommendation': 'Prime the pump before restart'}
subst = {
    'full': FULL,
    'story-only': {'description': 'Seal failed', 'root_cause': 'Dry running'},
    'blank-why': dict(FULL, root_cause='   '),
    'no-what': dict(FULL, description=None),
    'nothing': {},
    'whitespace-all': {'description': ' ', 'root_cause': '\t', 'recommendation': '\n'},
}
for tag, l in subst.items():
    case(f'substance-{tag}', 'hasSubstance', [l], o_has_substance(l))
    case(f'missing-{tag}', 'missingSubstance', [l], o_missing(l))
case('missing-default', 'missingSubstance', [UNDEF], o_missing({}))

val_rec = {
    'user': {'validated_at': iso(-1), 'validated_by': 'u-2'},
    'external-name': {'validated_at': iso(-1), 'validator_name': 'IOGP reviewer'},
    'blank-name': {'validated_at': iso(-1), 'validator_name': ' '},
    'no-date': {'validated_by': 'u-2'},
    'nothing': {},
}
for tag, l in val_rec.items():
    case(f'validation-record-{tag}', 'hasValidationRecord', [l], o_has_validation(l))

# --- canValidate
L = dict(FULL, id='L1', status='Submitted', author_id='u-author', created_by='u-clerk')
valid = [
    ('author-self', L, 'u-author', {}),
    ('other-user', L, 'u-other', {}),
    ('clerk-who-typed-it', L, 'u-clerk', {}),
    ('external-no-id', L, None, {}),
    ('author-falls-back-to-created-by', dict(L, author_id=None), 'u-clerk', {}),
    ('no-author-at-all', dict(FULL, id='L2'), 'u-any', {}),
    ('story-by-other', dict(L, recommendation=''), 'u-other', {}),
    ('story-external', dict(L, root_cause=None), None, {}),
    ('patch-supplies-recommendation', dict(L, recommendation=None), 'u-other', {'recommendation': 'Prime first'}),
    ('patch-blanks-description', L, 'u-other', {'description': ''}),
    ('author-and-story', dict(L, description=''), 'u-author', {}),
]
for tag, l, vid, patch in valid:
    case(f'validate-{tag}', 'canValidate', [l, vid, patch], o_can_validate(l, vid, patch))
case('validate-no-patch', 'canValidate', [L, 'u-other', UNDEF], o_can_validate(L, 'u-other'))

# --- applications
for o in OUTCOMES + ['Pending', None]:
    case(f'changed-{o}', 'didChangeSomething', [{'outcome': o}], o_changed({'outcome': o}))
case('changed-default', 'didChangeSomething', [UNDEF], False)

apps = [
    {'lesson_id': 'L1', 'outcome': 'Rejected', 'target_type': 'Procedure', 'applied_on': iso(1)},
    {'lesson_id': 'L1', 'outcome': 'Adopted', 'target_type': 'Risk register', 'applied_on': iso(-40)},
    {'lesson_id': 'L1', 'outcome': 'Adapted', 'target_type': 'Training', 'applied_on': iso(-2)},
    {'lesson_id': 'L1', 'outcome': 'Adopted', 'target_type': 'Risk register', 'applied_on': iso(-100)},
    {'lesson_id': 'L1', 'outcome': 'Adopted', 'target_type': None, 'applied_on': 'n/a'},
    {'lesson_id': 'L1', 'outcome': 'Adapted', 'target_type': 'Management of change'},
]
reuse_sets = {
    'mixed': apps,
    'empty': [],
    'rejected-only': [apps[0], dict(apps[0])],
    'undated-applied': [apps[4], apps[5]],
}
for tag, rows in reuse_sets.items():
    case(f'reuse-{tag}', 'reuseRecord', [rows], o_reuse(rows))
case('reuse-default', 'reuseRecord', [UNDEF], o_reuse([]))

rec = {
    'risk-with-key': {'target_type': 'Risk register', 'target_risk_id': 'r-1', 'outcome': 'Adopted'},
    'risk-without-key': {'target_type': 'Risk register', 'reference': 'RSK-1042', 'outcome': 'Adopted'},
    'moc-with-key': {'target_type': 'Management of change', 'target_moc_id': 'm-1', 'outcome': 'Adapted'},
    'moc-without-key': {'target_type': 'Management of change', 'outcome': 'Adapted'},
    'procedure-with-ref': {'target_type': 'Procedure', 'reference': 'OPS-PR-017 rev 4', 'outcome': 'Adopted'},
    'procedure-blank-ref': {'target_type': 'Procedure', 'reference': '  ', 'outcome': 'Adopted'},
    'training-no-ref': {'target_type': 'Training', 'outcome': 'Adopted'},
    'unknown-target': {'target_type': 'Newsletter', 'reference': 'Q3', 'outcome': 'Adopted'},
    'no-target': {'outcome': 'Adopted'},
    'no-outcome': {'target_type': 'Other', 'reference': 'x'},
    'bad-outcome': {'target_type': 'Other', 'reference': 'x', 'outcome': 'Maybe'},
    'rejected-no-notes': {'target_type': 'Design standard', 'reference': 'DEP 31.38', 'outcome': 'Rejected'},
    'rejected-blank-notes': {'target_type': 'Design standard', 'reference': 'DEP 31.38', 'outcome': 'Rejected', 'notes': ' '},
    'rejected-with-notes': {'target_type': 'Design standard', 'reference': 'DEP 31.38', 'outcome': 'Rejected', 'notes': 'Not applicable offshore'},
    'rejected-into-risk': {'target_type': 'Risk register', 'target_risk_id': 'r-2', 'outcome': 'Rejected', 'notes': 'Already covered'},
}
for t in TARGETS:
    rec[f'every-target-{t}'] = {'target_type': t, 'target_risk_id': 'r', 'target_moc_id': 'm', 'reference': 'ref', 'outcome': 'Adopted'}
for tag, a in rec.items():
    case(f'record-app-{tag}', 'canRecordApplication', [a], o_can_record(a))
case('record-app-default', 'canRecordApplication', [UNDEF], {'ok': False})

# --- workflow
for st in STATUSES + ['Published ', None]:
    case(f'next-{st}', 'nextLessonStatuses', [st], o_next(st))

for tag, a in [('none', []), ('rejected-only', reuse_sets['rejected-only']), ('one-adapted', [apps[2]]),
               ('mixed', apps)]:
    l = dict(L, status='Published')
    case(f'embed-{tag}', 'canEmbed', [l, a], o_can_embed(l, a))
case('embed-no-apps', 'canEmbed', [dict(L, status='Published'), UNDEF], {'ok': False})

arch = [
    ('reason-on-row', {'archive_reason': 'Superseded by the 2026 standard'}, {}),
    ('reason-in-patch', {}, {'archive_reason': 'Asset decommissioned'}),
    ('none', {}, {}),
    ('blank', {'archive_reason': '  '}, {}),
    ('patch-blank-overrides-row', {'archive_reason': 'old reason'}, {'archive_reason': ''}),
    ('patch-null-keeps-row', {'archive_reason': 'old reason'}, {'archive_reason': None}),
]
for tag, l, p in arch:
    case(f'archive-{tag}', 'canArchive', [l, p], o_can_archive(l, p))
case('archive-no-patch', 'canArchive', [{'archive_reason': 'x'}, UNDEF], {'ok': True})

sup = [
    ('successor-in-patch', {'id': 'L1'}, {'superseded_by': 'L9'}),
    ('successor-on-row', {'id': 'L1', 'superseded_by': 'L9'}, {}),
    ('none', {'id': 'L1'}, {}),
    ('itself', {'id': 'L1'}, {'superseded_by': 'L1'}),
    ('itself-on-row', {'id': 'L1', 'superseded_by': 'L1'}, {}),
    ('patch-empty-string', {'id': 'L1', 'superseded_by': 'L9'}, {'superseded_by': ''}),
]
for tag, l, p in sup:
    case(f'supersede-{tag}', 'canSupersede', [l, p], o_can_supersede(l, p))
case('supersede-no-patch', 'canSupersede', [{'id': 'L1'}, UNDEF], {'ok': False})

VAL = {'validated_at': iso(-1), 'validated_by': 'u-other'}
adv_lessons = {
    'Draft': dict(id='L1', status='Draft', author_id='u-author'),
    'Submitted': L,
    'Validated': dict(L, status='Validated', **VAL),
    'Published': dict(L, status='Published', **VAL, superseded_by=None),
    'Embedded': dict(L, status='Embedded', **VAL, archive_reason='Retired asset'),
    'Archived': dict(L, status='Archived'),
    'Superseded': dict(L, status='Superseded'),
}
good_ctx = {'validatorId': 'u-other', 'applications': [apps[1]],
            'patch': {'archive_reason': 'Duplicate of LL-2026-004', 'superseded_by': 'L9'}}
for st, l in adv_lessons.items():
    for to in STATUSES:
        case(f'advance-{st}-to-{to}', 'canAdvanceLesson', [l, to, good_ctx], o_can_advance(l, to, good_ctx))
more_adv = [
    ('submit-empty-draft', dict(id='L1', status='Draft'), 'Submitted', {}),
    ('validate-by-author', L, 'Validated', {'validatorId': 'u-author'}),
    ('validate-story', dict(L, recommendation=''), 'Validated', {'validatorId': 'u-other'}),
    ('validate-external', L, 'Validated', {}),
    ('publish-unvalidated', dict(L, status='Validated'), 'Published', {}),
    ('publish-validated-by-name', dict(L, status='Validated', validated_at=iso(-2), validator_name='Ext'), 'Published', {}),
    ('publish-validated-story', dict(L, status='Validated', recommendation=None, **VAL), 'Published', {'validatorId': 'u-other'}),
    ('embed-no-applications', dict(L, status='Published'), 'Embedded', {}),
    ('embed-rejected-only', dict(L, status='Published'), 'Embedded', {'applications': reuse_sets['rejected-only']}),
    ('archive-no-reason', dict(L, status='Published'), 'Archived', {}),
    ('archive-reason-on-row', dict(L, status='Draft', archive_reason='Duplicate'), 'Archived', {}),
    ('supersede-self', dict(L, status='Embedded'), 'Superseded', {'patch': {'superseded_by': 'L1'}}),
    ('supersede-nothing', dict(L, status='Embedded'), 'Superseded', {}),
    ('unknown-status', dict(L, status='Rejected'), 'Draft', {}),
    ('no-context', dict(L, status='Validated'), 'Submitted', UNDEF),
]
for tag, l, to, ctx in more_adv:
    case(f'advance-{tag}', 'canAdvanceLesson', [l, to, ctx], o_can_advance(l, to, ctx))

# --- dates
for st in STATUSES:
    for tag, off in [('yesterday', -1), ('today', 0), ('lead-edge', REVIEW_LEAD), ('lead-plus-1', REVIEW_LEAD + 1)]:
        l = {'status': st, 'review_due': iso(off)}
        case(f'review-overdue-{st}-{tag}', 'isReviewOverdue', [l, T], o_review_overdue(l, T))
        case(f'review-soon-{st}-{tag}', 'isReviewDueSoon', [l, T], o_review_soon(l, T))
for tag, v in [('null', None), ('garbage', 'annual'), ('invalid-date', INVALID_DATE)]:
    l = {'status': 'Published', 'review_due': v}
    case(f'review-overdue-{tag}', 'isReviewOverdue', [l, T], False)
    case(f'review-soon-{tag}', 'isReviewDueSoon', [l, T], False)

age = {
    'event-400': {'event_date': iso(-400)},
    'event-today': {'event_date': iso(0)},
    'event-future': {'event_date': iso(10)},
    'created-at-only': {'created_at': '2026-09-01T23:59:00Z'},
    'event-over-created': {'event_date': iso(-5), 'created_at': iso(-1) + 'T00:00:00Z'},
    'nothing': {},
    'garbage': {'event_date': 'Q2 2025'},
    'date-object': {'event_date': D(iso(-7))},
}
for tag, l in age.items():
    case(f'age-{tag}', 'lessonAgeDays', [l, T], o_age(l, T))
case('age-across-dst', 'lessonAgeDays', [{'event_date': '2026-03-28'}, D('2026-03-30')],
     o_age({'event_date': '2026-03-28'}, D('2026-03-30')))

for st in STATUSES:
    for tag, a in [('no-apps', []), ('rejected', reuse_sets['rejected-only']), ('adopted', [apps[1]])]:
        l = {'status': st}
        case(f'unapplied-{st}-{tag}', 'isUnapplied', [l, a], o_unapplied(l, a))
case('unapplied-default-apps', 'isUnapplied', [{'status': 'Published'}, UNDEF], True)

# --- search
lessons = [
    dict(id='A', status='Published', lesson_code='LL-2026-001', title='Pump seal failure on restart',
         description='Mechanical seal failed', root_cause='Dry running', recommendation='Prime before restart',
         category='Rotating equipment', discipline='Mechanical', source_type='Incident',
         applicability_scope='This asset', keywords=['pump', 'seal'], asset_id=0),
    dict(id='B', status='Draft', title='Drill bit optimisation', description='ROP improved',
         category='Drilling', discipline='Drilling', source_type='Success',
         applicability_scope='Industry-wide', author_name='Jane Smith', project_ref='WELL-7'),
    dict(id='C', status='Embedded', title='Permit handover', consequence='Near miss at the pump skid',
         category='Operations', discipline='Operations', source_type='Near miss',
         applicability_scope='This organization', department='Production', source_reference='NM-44'),
    dict(id='D', status='Archived', title='Pump', category='Rotating equipment', discipline='Mechanical',
         source_type='Incident', applicability_scope='This asset', asset_id=4417),
]
searches = [
    ('empty-query', '', {}),
    ('one-term', 'pump', {}),
    ('two-terms-both-needed', 'pump seal', {}),
    ('two-terms-one-missing', 'pump drill', {}),
    ('case-insensitive', 'PUMP   SEAL', {}),
    ('keyword-array', 'seal', {}),
    ('numeric-asset', '4417', {}),
    ('zero-asset-not-searchable', '0', {}),
    ('author', 'jane', {}),
    ('project-ref', 'well-7', {}),
    ('consequence-and-department', 'skid production', {}),
    ('code', 'll-2026-001', {}),
    ('status-filter', '', {'status': 'Draft'}),
    ('category-filter', 'pump', {'category': 'Rotating equipment'}),
    ('discipline-filter', '', {'discipline': 'Operations'}),
    ('source-filter', '', {'source_type': 'Incident'}),
    ('scope-filter', '', {'scope': 'This asset'}),
    ('visible-only', 'pump', {'visibleOnly': True}),
    ('falsy-filters-ignored', '', {'status': '', 'category': None, 'visibleOnly': False}),
    ('no-match', 'corrosion', {}),
]
for tag, q, f in searches:
    case(f'search-{tag}', 'searchLessons', [lessons, q, f], o_search(lessons, q, f))
case('search-defaults', 'searchLessons', [lessons, UNDEF, UNDEF], o_search(lessons, '', {}))
case('search-null-query', 'searchLessons', [lessons, None], o_search(lessons, None, {}))
case('search-empty-register', 'searchLessons', [[], 'pump', {}], [])

# --- summarise
reg = [
    dict(id='P1', status='Published', review_due=iso(-1)),
    dict(id='P2', status='Published', review_due=iso(REVIEW_LEAD)),
    dict(id='P3', status='Embedded', review_due=iso(REVIEW_LEAD + 1)),
    dict(id='P4', status='Embedded', review_due=iso(0)),
    dict(id='S1', status='Submitted', review_due=iso(-50)),
    dict(id='D1', status='Draft'),
    dict(id='D2', status='Draft'),
    dict(id='V1', status='Validated', review_due=iso(3)),
    dict(id='A1', status='Archived', review_due=iso(-5)),
    dict(id='X1', status='Superseded'),
    dict(id='Q1', status='Retired'),
]
reg_apps = [
    {'lesson_id': 'P1', 'outcome': 'Rejected', 'target_type': 'Procedure'},
    {'lesson_id': 'P2', 'outcome': 'Adopted', 'target_type': 'Risk register'},
    {'lesson_id': 'P2', 'outcome': 'Adapted', 'target_type': 'Management of change'},
    {'lesson_id': 'P3', 'outcome': 'Adapted', 'target_type': 'Risk register'},
    {'lesson_id': 'A1', 'outcome': 'Adopted', 'target_type': 'Management of change'},
    {'lesson_id': 'ZZ', 'outcome': 'Adopted', 'target_type': 'Training'},
    {'lesson_id': 'P4', 'outcome': 'Rejected', 'target_type': 'Risk register'},
    {'lesson_id': 'P4', 'outcome': None, 'target_type': 'Risk register'},
]
data = {'lessons': reg, 'applications': reg_apps}
case('summarise-register', 'summarise', [data, T], o_summarise(data, T))
case('summarise-empty', 'summarise', [{}, T], o_summarise({}, T))
case('summarise-default', 'summarise', [UNDEF, T], o_summarise({}, T))
case('summarise-no-applications', 'summarise', [{'lessons': reg}, T], o_summarise({'lessons': reg}, T))
case('summarise-a-day-later', 'summarise', [data, D(iso(1))], o_summarise(data, D(iso(1))))

# --- countBy
rows = [{'source_type': 'Incident'}, {'source_type': 'Near miss'}, {'source_type': 'Incident'},
        {'source_type': None}, {}, {'source_type': 'Success'}, {'source_type': 'Near miss'}]
case('countBy-source', 'countBy', [rows, 'source_type'], o_count_by(rows, 'source_type'))
case('countBy-unset-label', 'countBy', [rows, 'source_type', 'Not recorded'], o_count_by(rows, 'source_type', 'Not recorded'))
case('countBy-empty', 'countBy', [[], 'category'], [])

# --- lessonByAttention
att_rows = [
    dict(id='archived', status='Archived', event_date=iso(-1)),
    dict(id='draft-old', status='Draft', event_date=iso(-300)),
    dict(id='draft-new', status='Draft', event_date=iso(-3)),
    dict(id='applied-review-overdue', status='Published', review_due=iso(-1), event_date=iso(-90)),
    dict(id='unapplied-old', status='Published', event_date=iso(-200)),
    dict(id='submitted', status='Submitted', created_at=iso(-10) + 'T09:00:00Z'),
    dict(id='unapplied-new', status='Embedded', event_date=iso(-20)),
    dict(id='applied-current', status='Embedded', review_due=iso(100), event_date=iso(-60)),
    dict(id='rejected-only-unapplied', status='Published', event_date=iso(-100)),
    dict(id='superseded', status='Superseded', event_date=iso(-400)),
]
by_lesson = {
    'applied-review-overdue': [{'outcome': 'Adopted'}],
    'applied-current': [{'outcome': 'Adapted'}],
    'rejected-only-unapplied': [{'outcome': 'Rejected', 'notes': 'n/a'}],
}
tag_map = {'$map': [[k, v] for k, v in by_lesson.items()]}
cases.append({'id': 'attention-register', 'sort': 'lessonByAttention', 'factory': True,
              'factoryArgs': [tag_map, T], 'rows': att_rows,
              'expectedOrder': attention_order(att_rows, by_lesson, T)})
cases.append({'id': 'attention-empty-map', 'sort': 'lessonByAttention', 'factory': True,
              'factoryArgs': [{'$map': []}, T], 'rows': att_rows[:6],
              'expectedOrder': attention_order(att_rows[:6], {}, T)})
# An undated lesson between two dated ones (LL-1): the engine calls it equal
# to both, which is not an ordering, so the dated pair is left unsorted.
und = [dict(id='jan', status='Draft', event_date='2026-01-10'),
       dict(id='undated', status='Draft'),
       dict(id='may', status='Draft', event_date='2026-05-10')]
cases.append({'id': 'attention-undated-between-dated', 'sort': 'lessonByAttention', 'factory': True,
              'factoryArgs': [{'$map': []}, T], 'rows': und,
              'expectedOrder': attention_order(und, {}, T), 'repaired': 'LL-1'})

golden = {
    'module': 'lessonsLearned',
    'generatedBy': 'tools/validation/assurance/oracle_lessons.py',
    'description': 'Independent stdlib-Python oracle for the Lessons Learned rules: author may not '
                   'validate their own lesson, an anecdote is not a lesson, Embedded is earned by an '
                   'Adopted or Adapted application, the reuse record is counted, application and '
                   'archive/supersede requirements, review dates (lead 30 days), search, the '
                   'dashboard summary and the attention sort. Findings: FINDINGS-lessons.md.',
    'cases': cases,
}

if __name__ == '__main__':
    with open(OUT, 'w') as f:
        json.dump(golden, f, indent=1)
        f.write('\n')
    print(f'{len(cases)} cases -> {os.path.normpath(OUT)}')
