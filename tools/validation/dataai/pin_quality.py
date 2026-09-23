#!/usr/bin/env python3
"""Second-witness pins for engines/dataai/quality.js (Data & AI D1).

Needs numpy, scipy, statsmodels and pandas (NOT the stdlib oracle; this
is the second, library witness):

    /root/daienv/bin/python tools/validation/dataai/pin_quality.py

It reads the INPUTS of selected cases from the oracle's golden file
(test-data/dataai/goldens/quality_cases.json, never its expected values)
and writes test-data/dataai/pins/quality_pins.json. The jest gate checks the
engine against these pins as well as against the oracle, so each pinned
value has two independent witnesses. It also prints the worst disagreement
between the stdlib oracle and these libraries (the oracle-agreement figure
in FINDINGS-quality.md).
"""
import json
import os

import numpy as np
import pandas as pd
import scipy
import statsmodels
import statsmodels.api as sm
from scipy import special, stats

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '..')
GOLD = os.path.join(ROOT, 'test-data', 'dataai', 'goldens', 'quality_cases.json')
DEST = os.path.join(ROOT, 'test-data', 'dataai', 'pins', 'quality_pins.json')

NP_METHOD = {'R6': 'weibull', 'R7': 'linear', 'R8': 'median_unbiased'}
TOL = 1e-12
TOL_SPECIAL = 1e-10


def f(x):
    return None if x is None else float(x)


def present(values):
    return np.array([v for v in values if v is not None], dtype=float)


def main():
    G = json.load(open(GOLD))
    pins = []
    worst = {}

    def pin(case, field, value, tol=TOL, lib=''):
        pins.append({'id': f'{case["id"]}:{field or "value"}', 'case': case['id'], 'field': field, 'value': value, 'tol': tol, 'witness': lib})
        # oracle agreement: compare the oracle's own expected value where it carries this field
        exp = case['expected']
        ov = exp if field == '' else exp.get(field) if isinstance(exp, dict) else None
        if isinstance(ov, (int, float)) and isinstance(value, float) and value != 0:
            rel = abs(ov - value) / abs(value)
            worst[case['fn']] = max(worst.get(case['fn'], 0.0), rel)

    for c in G['cases']:
        e = c['expected']
        if isinstance(e, dict) and e.get('error') is True:
            continue
        a = c['args']
        fn = c['fn']
        if fn == 'sampleQuantile':
            vals, p, m = a
            pin(c, '', float(np.quantile(present(vals), p, method=NP_METHOD[m])), lib='numpy.quantile')
        elif fn == 'zScores':
            x = present(a['values'])
            ddof = 0 if a.get('sd') == 'population' else 1
            z = stats.zscore(x, ddof=ddof)
            it = iter(z)
            pin(c, 'z', [None if v is None else float(next(it)) for v in a['values']], lib='scipy.stats.zscore')
            pin(c, 'sd', float(np.std(x, ddof=ddof)), lib='numpy.std')
        elif fn == 'modifiedZScores':
            x = present(a['values'])
            pin(c, 'median', float(np.median(x)), lib='numpy.median')
            pin(c, 'mad', float(stats.median_abs_deviation(x, scale=1.0)), lib='scipy.stats.median_abs_deviation')
            pin(c, 'mad', float(sm.robust.mad(x, c=1.0, center=np.median)), lib='statsmodels.robust.mad')
        elif fn == 'iqrFences':
            x = present(a['values'])
            m = NP_METHOD[a.get('method', 'R7')]
            q1, q3 = np.quantile(x, [0.25, 0.75], method=m)
            pin(c, 'q1', float(q1), lib='numpy.quantile')
            pin(c, 'q3', float(q3), lib='numpy.quantile')
            if a.get('method', 'R7') == 'R7':
                pin(c, 'iqr', float(stats.iqr(x)), lib='scipy.stats.iqr')
        elif fn == 'grubbsTest':
            x = present(a['values'])
            n = len(x)
            alpha = a.get('alpha', 0.05)
            side = a.get('side', 'two-sided')
            q = alpha / (2 * n) if side == 'two-sided' else alpha / n
            t = float(stats.t.isf(q, n - 2))
            pin(c, 'tCritical', t, TOL_SPECIAL, 'scipy.stats.t.isf')
            pin(c, 'critical', float((n - 1) / np.sqrt(n) * np.sqrt(t * t / (n - 2 + t * t))), TOL_SPECIAL, 'scipy.stats.t.isf')
        elif fn == 'studentTUpperQuantile':
            pin(c, '', float(stats.t.isf(a[0], a[1])), TOL_SPECIAL, 'scipy.stats.t.isf')
        elif fn == 'regularizedBeta':
            pin(c, '', float(special.betainc(a[1], a[2], a[0])), TOL_SPECIAL, 'scipy.special.betainc')
        elif fn == 'mahalanobis':
            rows = a['rows']
            keep = [i for i, r in enumerate(rows) if not any(v is None for v in r)]
            X = np.array([rows[i] for i in keep], dtype=float)
            mu = X.mean(axis=0)
            cov = np.atleast_2d(np.cov(X, rowvar=False, ddof=1))
            inv = np.linalg.inv(cov)
            d2 = [None] * len(rows)
            for i, r in zip(keep, X):
                d2[i] = float((r - mu) @ inv @ (r - mu))
            pin(c, 'd2', d2, 1e-9, 'numpy.cov + numpy.linalg.inv')
            pin(c, 'cutoff', float(stats.chi2.ppf(1 - a.get('alpha', 0.025), X.shape[1])), TOL_SPECIAL, 'scipy.stats.chi2.ppf')
        elif fn == 'ewmaChart':
            s = pd.Series([a['target']] + list(a['values']), dtype=float)
            ew = s.ewm(alpha=a['lambda'], adjust=False).mean().to_numpy()[1:]
            pin(c, 'ewma', [float(v) for v in ew], 1e-12, 'pandas.Series.ewm(adjust=False)')
        elif fn == 'individualsChart':
            x = np.array(a['values'], dtype=float)
            if 'mrBar' not in a:
                pin(c, 'mrBar', float(np.mean(np.abs(np.diff(x)))), lib='numpy.diff')
            if 'centre' not in a:
                pin(c, 'centre', float(np.mean(x)), lib='numpy.mean')

    out = {
        'module': 'quality',
        'generatedBy': 'tools/validation/dataai/pin_quality.py',
        'versions': {'numpy': np.__version__, 'scipy': scipy.__version__, 'statsmodels': statsmodels.__version__, 'pandas': pd.__version__},
        'note': 'second witness on the golden inputs; the stdlib oracle is the first',
        'pins': pins,
    }
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with open(DEST, 'w') as fh:
        json.dump(out, fh, indent=1, allow_nan=False)
        fh.write('\n')
    print('wrote', os.path.relpath(DEST), len(pins), 'pins')
    print('worst relative disagreement, stdlib oracle vs libraries, by function:')
    for k, v in sorted(worst.items()):
        print(f'  {k:24s} {v:.2e}')


if __name__ == '__main__':
    main()
