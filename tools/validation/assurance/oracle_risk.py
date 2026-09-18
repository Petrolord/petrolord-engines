#!/usr/bin/env python3
"""
Independent oracle for engines/assurance/riskScoring.js (AS12, group A).

Stdlib only. The rules, from the module docstring and
AssuranceApps-STATUS.md section 3 (AS2), in standard ISO 31000 5x5 terms:

  * Likelihood and impact are levels on a 1..5 scale. A level off the
    scale, or missing, is refused: the score is 0, "the only score that
    maps to NO_BAND. It never guesses a level." (STATUS 3.2: a 9x9 must
    not score 81.)
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


def overdue(r, as_of):
    due = to_date(r.get('next_review_date'))
    if due is None:
        return False
    return due < to_date(as_of)


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
    c.add('review-due-today-date', 'isReviewOverdue', [{'next_review_date': D('2026-09-17')}, T], False)
    c.add('review-due-yesterday-date', 'isReviewOverdue', [{'next_review_date': D('2026-09-16')}, T], True)
    # RS-1: the string form of 'due today'. Held in every zone by the sweep;
    # before the repair it read overdue west of Greenwich (UTC parse).
    c.add('review-due-today-string', 'isReviewOverdue', [{'next_review_date': '2026-09-17'}, T], False, defect='RS-1')
    c.add('review-due-yesterday', 'isReviewOverdue', [{'next_review_date': '2026-09-16'}, T], True)
    c.add('review-due-tomorrow', 'isReviewOverdue', [{'next_review_date': '2026-09-18'}, T], False)
    c.add('review-due-last-year', 'isReviewOverdue', [{'next_review_date': '2025-09-17'}, T], True)
    c.add('review-across-dst', 'isReviewOverdue', [{'next_review_date': '2026-03-07'}, D('2026-03-09')], True)
    c.add('review-none', 'isReviewOverdue', [{}, T], False)
    c.add('review-empty', 'isReviewOverdue', [{'next_review_date': ''}, T], False)
    c.add('review-garbage', 'isReviewOverdue', [{'next_review_date': 'garbage'}, T], False)
    c.add('review-no-arg-risk', 'isReviewOverdue', [UNDEF, T], False)
    c.add('review-feb-30', 'isReviewOverdue', [{'next_review_date': '2026-02-30'}, D('2026-03-05')],
          False, defect='RS-1')

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
