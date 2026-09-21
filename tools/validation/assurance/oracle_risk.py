#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/riskScoring.js (AS12, group A).

Stdlib only. The rules, from the module docstring and
AssuranceApps-STATUS.md section 3 (AS2), in standard ISO 31000 5x5 terms:

  * Likelihood and impact are levels on a 1..5 scale. A level off the
    scale, or missing, is refused: the score is 0, "the only score that
    maps to NO_BAND. It never guesses a level." (STATUS 3.2: a 9x9 must
    not score 81.)
  * AS15 owner decision Q3 (2026-09-18): a level is one of the five
    WHOLE levels. A fraction (2.5, '3.5') is off the scale and so
    unscored; a whole number written as '3', 3.0 or '4.0' is that level.
  * Score = likelihood x impact.
  * Bands, inclusive lower bounds: Critical >= 15, High >= 10, Medium >= 5,
    Low >= 1, and 'None' for a score of 0 (or anything not positive).
  * Residual falls back PER AXIS to the inherent level when the residual
    level has not been assessed (STATUS 3.4: "mitigation that cuts
    likelihood but not impact must not silently reset impact").
    Not assessed = no value: null, undefined, or the empty string the
    register's own form uses for "none" (RiskForm initialises
    residual_likelihood to '' and maps the 'none' option to '').
  * Appetite: no positive numeric target -> 'Not set'; no residual score
    -> 'Not set'; residual <= target -> 'Within appetite', else 'Above'.
  * A review due today is not overdue; one due yesterday is. The due
    date is a calendar date (calendar.js's rule: local midnight), an
    unreadable one is no date and so not overdue.
  * ASC-0 RC-1: the as-of date is a calendar date by the same rule, a
    string as much as a Date; an unreadable as-of date decides nothing.
  * ASC-0 RC-2: only a LIVE risk (Open, Under Review, Mitigated,
    Realized) carries a review obligation, like every other overdue test
    in the family. Closed, Draft, an unknown status or none: not overdue.
  * deriveRiskFields: rating is the INHERENT band (STATUS 3.2: the stored
    band agrees with the stored score, risk_score, which is inherent).
  * countByBand counts every risk into exactly one of the five bands.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oracle_calendar import (  # noqa: E402
    Cases, D, UNDEF, NAN, js_number, to_date, truthy, pynum,
)

BANDS = [('Critical', 15), ('High', 10), ('Medium', 5), ('Low', 1)]
NONE = 'None'
WITHIN, ABOVE, NOT_SET = 'Within appetite', 'Above appetite', 'Not set'


def level(v):
    n = js_number(v)
    if n != n or n in (float('inf'), float('-inf')):
        return None
    if n < 1 or n > 5:
        return None
    if n != int(n):
        return None
    return n


def score(l, i):
    a, b = level(l), level(i)
    return 0 if a is None or b is None else pynum(a * b)


def band(s):
    n = js_number(s)
    if n != n or n <= 0:
        return NONE
    for name, lo in BANDS:
        if n >= lo:
            return name
    return NONE


def assessed(v):
    return not (v is None or v is UNDEF or v == '')


def residual(r):
    l = r.get('residual_likelihood') if assessed(r.get('residual_likelihood')) else r.get('likelihood')
    i = r.get('residual_impact') if assessed(r.get('residual_impact')) else r.get('impact')
    return score(l, i)


def appetite(r):
    t = js_number(r.get('target_score'))
    if t != t or t in (float('inf'), float('-inf')) or t <= 0:
        return NOT_SET
    res = residual(r)
    if res <= 0:
        return NOT_SET
    return WITHIN if res <= t else ABOVE


LIVE = ('Open', 'Under Review', 'Mitigated', 'Realized')


def overdue(r, as_of):
    if not isinstance(r, dict) or r.get('status') not in LIVE:
        return False
    today = to_date(as_of)
    due = to_date(r.get('next_review_date'))
    if due is None or today is None:
        return False
    return due < today


def derive(r):
    s = score(r.get('likelihood'), r.get('impact'))
    res = residual(r)
    return {'inherentScore': s, 'inherentBand': band(s), 'residualScore': res,
            'residualBand': band(res), 'rating': band(s), 'appetite_status': appetite(r)}


def count_by_band(risks, use_residual=False):
    out = {'Critical': 0, 'High': 0, 'Medium': 0, 'Low': 0, NONE: 0}
    for r in risks:
        s = residual(r) if use_residual else score(r.get('likelihood'), r.get('impact'))
        out[band(s)] += 1
    return out


def build():
    c = Cases('riskScoring', 'tools/validation/assurance/oracle_risk.py',
              'ISO 31000 5x5 likelihood x impact scoring, bands, per-axis residual, appetite, '
              'review overdue and band counts, from the module docstring and STATUS section 3.')

    # every cell of the matrix, score and band
    for l in range(1, 6):
        for i in range(1, 6):
            s = score(l, i)
            c.add(f'score-{l}x{i}', 'calculateRiskScore', [l, i], s)
    for s in sorted({l * i for l in range(1, 6) for i in range(1, 6)}):
        c.add(f'band-{s}', 'getRiskBand', [s], band(s))
    # refused levels
    for cid, (l, i) in {
        'score-zero-l': (0, 3), 'score-six-i': (3, 6), 'score-9x9': (9, 9), 'score-neg': (-1, 3),
        'score-null': (None, 3), 'score-undefined': (3, UNDEF), 'score-empty': ('', 4),
        'score-text': ('high', 4), 'score-nan': (NAN, 2),
    }.items():
        c.add(cid, 'calculateRiskScore', [l, i], 0)
    c.add('score-numeric-strings', 'calculateRiskScore', ['3', '5'], 15)
    # AS15 Q3: fractions are not levels
    for cid, (l, i) in {
        'as15-q3-half-likelihood': (2.5, 4), 'as15-q3-half-impact': (3, 2.5),
        'as15-q3-both-fractional': (2.5, 2.5), 'as15-q3-string-fraction': ('3.5', 4),
        'as15-q3-near-five': (4.9, 5), 'as15-q3-just-above-one': (1.01, 3),
    }.items():
        c.add(cid, 'calculateRiskScore', [l, i], score(l, i), defect='AS15-Q3')
    for cid, (l, i) in {
        'as15-q3-whole-float': (3.0, 4.0), 'as15-q3-string-whole-float': ('4.0', '2'),
        'as15-q3-true-is-one': (True, 5), 'as15-q3-spaced-string': (' 3 ', 3),
    }.items():
        c.add(cid, 'calculateRiskScore', [l, i], score(l, i))
    frac = {'likelihood': 4, 'impact': 5, 'residual_likelihood': 1.5, 'residual_impact': 2}
    c.add('as15-q3-residual-fraction', 'calculateResidualScore', [frac], residual(frac), defect='AS15-Q3')
    c.add('as15-q3-derive-fraction', 'deriveRiskFields', [{'likelihood': 2.5, 'impact': 4}],
          derive({'likelihood': 2.5, 'impact': 4}), defect='AS15-Q3')
    c.add('score-no-args', 'calculateRiskScore', [], 0)
    # bands: edges and the unscored
    for cid, s in {
        'band-zero': 0, 'band-negative': -3, 'band-null': None, 'band-undefined': UNDEF,
        'band-nan': NAN, 'band-text': 'x', 'band-string-15': '15', 'band-string-14': '14',
        'band-half': 0.5, 'band-4.5': 4.5, 'band-9.5': 9.5, 'band-14.5': 14.5, 'band-26': 26, 'band-30': 30,
    }.items():
        c.add(cid, 'getRiskBand', [s], band(s))

    # residual
    res_cases = {
        'residual-unassessed': {'likelihood': 4, 'impact': 5},
        'residual-both': {'likelihood': 4, 'impact': 5, 'residual_likelihood': 2, 'residual_impact': 3},
        'residual-likelihood-only': {'likelihood': 4, 'impact': 5, 'residual_likelihood': 2},
        'residual-impact-only': {'likelihood': 4, 'impact': 5, 'residual_impact': 1},
        'residual-null-axes': {'likelihood': 3, 'impact': 3, 'residual_likelihood': None, 'residual_impact': None},
        'residual-off-scale': {'likelihood': 3, 'impact': 3, 'residual_likelihood': 7, 'residual_impact': 2},
        'residual-no-inherent': {},
    }
    for cid, r in res_cases.items():
        c.add(cid, 'calculateResidualScore', [r], residual(r))
    c.add('residual-no-arg', 'calculateResidualScore', [], 0)
    # the form's own "not assessed" value is '' (RS-2)
    for cid, r in {
        'residual-form-empty-both': {'likelihood': 4, 'impact': 5, 'residual_likelihood': '', 'residual_impact': ''},
        'residual-form-empty-impact': {'likelihood': 4, 'impact': 5, 'residual_likelihood': 2, 'residual_impact': ''},
    }.items():
        c.add(cid, 'calculateResidualScore', [r], residual(r), defect='RS-2')

    # appetite
    app = {
        'appetite-no-target': {'likelihood': 3, 'impact': 3},
        'appetite-null-target': {'likelihood': 3, 'impact': 3, 'target_score': None},
        'appetite-zero-target': {'likelihood': 3, 'impact': 3, 'target_score': 0},
        'appetite-negative-target': {'likelihood': 3, 'impact': 3, 'target_score': -4},
        'appetite-text-target': {'likelihood': 3, 'impact': 3, 'target_score': 'low'},
        'appetite-empty-target': {'likelihood': 3, 'impact': 3, 'target_score': ''},
        'appetite-at-target': {'likelihood': 3, 'impact': 3, 'target_score': 9},
        'appetite-one-above': {'likelihood': 2, 'impact': 5, 'target_score': 9},
        'appetite-residual-within': {'likelihood': 5, 'impact': 5, 'residual_likelihood': 2,
                                     'residual_impact': 2, 'target_score': 6},
        'appetite-residual-above': {'likelihood': 5, 'impact': 5, 'residual_likelihood': 3,
                                    'target_score': 12},
        'appetite-string-target': {'likelihood': 2, 'impact': 3, 'target_score': '6'},
        'appetite-unscored': {'target_score': 10},
    }
    for cid, r in app.items():
        c.add(cid, 'getAppetiteStatus', [r], appetite(r))
    c.add('appetite-no-arg', 'getAppetiteStatus', [], NOT_SET)
    c.add('appetite-form-empty-residual', 'getAppetiteStatus',
          [{'likelihood': 4, 'impact': 4, 'residual_likelihood': '', 'residual_impact': '', 'target_score': 8}],
          ABOVE, defect='RS-2')

    # review overdue. A string due date equal to today is NOT pinned here:
    # the engine gets it right in UTC and east, wrong west (RS-1), and the
    # harness cannot pin a zone-dependent defect. Due-today is pinned with a
    # Date instead, and the strings stay a day or more away from the edge.
    T = D('2026-09-17')
    # ASC-0 RC-2: every date case below is asked of an Open risk; before
    # RC-2 they carried no status, which is now "not known to be live".
    L = {'status': 'Open'}

    def rv(cid, risk, as_of, defect=None):
        c.add(cid, 'isReviewOverdue', [risk, as_of], overdue(risk, as_of), defect=defect)

    rv('review-due-today-date', {**L, 'next_review_date': D('2026-09-17')}, T)
    rv('review-due-yesterday-date', {**L, 'next_review_date': D('2026-09-16')}, T)
    # RS-1: the string form of 'due today'. Held in every zone by the sweep;
    # before the repair it read overdue west of Greenwich (UTC parse).
    rv('review-due-today-string', {**L, 'next_review_date': '2026-09-17'}, T, 'RS-1')
    rv('review-due-yesterday', {**L, 'next_review_date': '2026-09-16'}, T)
    rv('review-due-tomorrow', {**L, 'next_review_date': '2026-09-18'}, T)
    rv('review-due-last-year', {**L, 'next_review_date': '2025-09-17'}, T)
    rv('review-across-dst', {**L, 'next_review_date': '2026-03-07'}, D('2026-03-09'))
    rv('review-none', {**L}, T)
    rv('review-empty', {**L, 'next_review_date': ''}, T)
    rv('review-garbage', {**L, 'next_review_date': 'garbage'}, T)
    rv('review-no-arg-risk', UNDEF, T)
    rv('review-feb-30', {**L, 'next_review_date': '2026-02-30'}, D('2026-03-05'), 'RS-1')

    # ASC-0 RC-1: a STRING as-of date is a calendar date. The previous
    # engine read it as a UTC instant, the day before west of Greenwich, so
    # these hold in UTC and fail under America/Los_Angeles, St John's and
    # Pacific/Pago_Pago in the zone sweep.
    rv('rc1-string-asof-day-after', {**L, 'next_review_date': '2026-09-30'}, '2026-10-01', 'RC-1')
    rv('rc1-string-asof-due-day', {**L, 'next_review_date': '2026-09-30'}, '2026-09-30', 'RC-1')
    rv('rc1-timestamp-asof', {**L, 'next_review_date': '2026-09-30'}, '2026-10-01T00:00:00Z', 'RC-1')
    rv('rc1-string-asof-year-end', {**L, 'next_review_date': '2026-12-31'}, '2027-01-01', 'RC-1')
    rv('rc1-unreadable-asof', {**L, 'next_review_date': '2020-01-01'}, 'yesterday', 'RC-1')
    rv('rc1-invalid-date-asof', {**L, 'next_review_date': '2020-01-01'}, D(None), 'RC-1')

    # ASC-0 RC-2: only a live risk can be review-overdue.
    for st in LIVE:
        rv(f'rc2-live-{st.lower().replace(" ", "-")}', {'status': st, 'next_review_date': '2026-01-10'}, T, 'RC-2')
    for tag, st in [('closed', 'Closed'), ('draft', 'Draft'), ('no-status', UNDEF),
                    ('null-status', None), ('unknown-status', 'Archived'), ('lower-case-open', 'open')]:
        risk = {'next_review_date': '2026-01-10'}
        if st is not UNDEF:
            risk['status'] = st
        rv(f'rc2-not-live-{tag}', risk, T, 'RC-2')

    # deriveRiskFields
    der = {
        'derive-critical-mitigated': {'likelihood': 5, 'impact': 4, 'residual_likelihood': 2,
                                      'residual_impact': 2, 'target_score': 6},
        'derive-3x5-boundary': {'likelihood': 3, 'impact': 5},
        'derive-unscored': {},
        'derive-partial-residual': {'likelihood': 4, 'impact': 3, 'residual_impact': 1, 'target_score': 4},
        'derive-above': {'likelihood': 2, 'impact': 2, 'target_score': 3},
    }
    for cid, r in der.items():
        c.add(cid, 'deriveRiskFields', [r], derive(r))
    c.add('derive-no-arg', 'deriveRiskFields', [], derive({}))
    form = {'likelihood': 4, 'impact': 5, 'residual_likelihood': 2, 'residual_impact': '', 'target_score': 8}
    c.add('derive-form-empty-residual', 'deriveRiskFields', [form], derive(form), defect='RS-2')

    # countByBand
    risks = [
        {'likelihood': 5, 'impact': 5},
        {'likelihood': 3, 'impact': 5, 'residual_likelihood': 1},
        {'likelihood': 2, 'impact': 5, 'residual_likelihood': 1, 'residual_impact': 1},
        {'likelihood': 3, 'impact': 3},
        {'likelihood': 1, 'impact': 4},
        {'likelihood': 9, 'impact': 9},
        {},
        {'likelihood': 2, 'impact': 2, 'residual_impact': 5},
    ]
    c.add('bands-inherent', 'countByBand', [risks], count_by_band(risks))
    c.add('bands-residual', 'countByBand', [risks, {'residual': True}], count_by_band(risks, True))
    c.add('bands-residual-false', 'countByBand', [risks, {'residual': False}], count_by_band(risks))
    c.add('bands-empty', 'countByBand', [[]], count_by_band([]))
    c.add('bands-no-arg', 'countByBand', [], count_by_band([]))
    return c


if __name__ == '__main__':
    build().write('riskScoring_cases.json')
