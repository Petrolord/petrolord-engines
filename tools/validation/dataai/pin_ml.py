#!/usr/bin/env python3
"""Second-witness pins for engines/dataai/ml.js (Data & AI D2).

Needs numpy, scipy, scikit-learn and statsmodels (NOT the stdlib oracle;
this is the second, library witness):

    /root/daienv/bin/python tools/validation/dataai/pin_ml.py

It reads the INPUTS of selected cases from the oracle's golden file
(test-data/dataai/goldens/ml_cases.json) and writes
test-data/dataai/pins/ml_pins.json. For the learning curve and the leakage
demo it also reads the oracle's split indices (the split itself is seeded
mulberry32, which no library shares) and refits with the library. The jest
gate checks the engine against these pins as well as against the oracle.

Pin tolerances. A library is a witness only to its own accuracy, so each
pin's relative tolerance is max(TOL, 10 x the library's own relative
disagreement with the exact oracle value), rounded up to a power of ten;
where the oracle value is exactly 0 the pin carries an absolute tolerance
the same way. The script prints the worst disagreement per function (the
witness-agreement table in FINDINGS-ml.md).

Mappings stated here once:
  ridge     sklearn Ridge(alpha = lambda, fit_intercept = True, solver = 'svd')
            on StandardScaler (ddof 0) features: coef_ is the engine's
            standardizedCoefficients[1:], intercept_ its [0] (the mean of y).
  logistic  statsmodels Logit (unpenalised MLE, Newton); scikit-learn
            LogisticRegression(C = inf for no penalty, C = 1 / l2 for the L2
            penalty, solver = 'newton-cholesky'), which does not penalise
            the intercept.
  log loss  numpy on np.clip(p, eps, 1 - eps), and sklearn log_loss where no
            probability needs clipping.
"""
import json
import math
import os

import numpy as np
import scipy
import sklearn
import statsmodels
import statsmodels.api as sm
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import (accuracy_score, confusion_matrix, log_loss, mean_absolute_error, mean_squared_error,
                             precision_recall_fscore_support, r2_score, roc_auc_score, roc_curve)
from sklearn.preprocessing import MinMaxScaler, StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '..')
GOLD = os.path.join(ROOT, 'test-data', 'dataai', 'goldens', 'ml_cases.json')
DEST = os.path.join(ROOT, 'test-data', 'dataai', 'pins', 'ml_pins.json')
TOL = 1e-10


def up10(x):
    return 10.0 ** math.ceil(math.log10(x)) if x > 0 else 0.0


def get(obj, dotted):
    for k in dotted.split('.'):
        obj = obj[int(k)] if isinstance(obj, list) else obj[k]
    return obj


def main():
    G = json.load(open(GOLD))
    pins = []
    worst = {}
    skipped = []

    def pin(case, field, value, lib):
        value = value.tolist() if hasattr(value, 'tolist') else value
        if any(isinstance(v, float) and not math.isfinite(v) for v in (value if isinstance(value, list) else [value])):
            skipped.append((case['id'], field, lib))
            return
        exp = get(case['expected'], field)
        flat_v = value if isinstance(value, list) else [value]
        flat_e = exp if isinstance(exp, list) else [exp]
        rel, ab = 0.0, 0.0
        for v, e in zip(flat_v, flat_e):
            if isinstance(e, bool) or not isinstance(e, (int, float)):
                continue
            if e == 0:
                ab = max(ab, abs(v))
            else:
                rel = max(rel, abs(v - e) / abs(e))
        if rel > 1e-2:
            skipped.append((case['id'], field, lib, f'library off by {rel:.2g} relative: no witness'))
            return
        worst[case['fn']] = max(worst.get(case['fn'], 0.0), rel)
        pid = f"{case['id']}:{field}"
        k = 2
        while any(p['id'] == pid for p in pins):
            pid = f"{case['id']}:{field}#{k}"
            k += 1
        entry = {'id': pid, 'case': case['id'], 'field': field, 'value': value,
                 'tol': max(TOL, up10(10 * rel)), 'witness': lib}
        if ab > 0:
            entry['abs'] = max(1e-12, up10(10 * ab))
        pins.append(entry)

    for c in G['cases']:
        e, a, fn = c['expected'], c['args'], c['fn']
        if isinstance(e, dict) and e.get('error'):
            continue
        if fn == 'ols':
            X = np.array(a['X'], dtype=float)
            y = np.array(a['y'], dtype=float)
            icpt = a.get('intercept', True)
            A = sm.add_constant(X, has_constant='add') if icpt else X
            res = sm.OLS(y, A).fit(method='qr')
            pin(c, 'coefficients', res.params, 'statsmodels OLS (qr)')
            pin(c, 'standardErrors', res.bse, 'statsmodels OLS bse')
            pin(c, 'residualSE', float(np.sqrt(res.scale)), 'statsmodels OLS sqrt(scale)')
            pin(c, 'rSquared', float(res.rsquared), 'statsmodels OLS rsquared')
            pin(c, 'adjustedRSquared', float(res.rsquared_adj), 'statsmodels OLS rsquared_adj')
            pin(c, 'conditionNumber', float(np.linalg.cond(A)), 'numpy.linalg.cond')
            pin(c, 'scaledConditionNumber', float(np.linalg.cond(A / np.linalg.norm(A, axis=0))), 'numpy.linalg.cond, unit columns')
        elif fn == 'ridge':
            X = np.array(a['X'], dtype=float)
            y = np.array(a['y'], dtype=float)
            sc = StandardScaler().fit(X)
            m = Ridge(alpha=a['lambda'], fit_intercept=True, solver='svd').fit(sc.transform(X), y)
            pin(c, 'standardizedCoefficients', [float(m.intercept_)] + list(map(float, m.coef_)), 'sklearn Ridge(alpha=lambda) on StandardScaler')
            pin(c, 'scaler.scale', sc.scale_, 'sklearn StandardScaler.scale_')
        elif fn == 'logistic':
            X = np.array(a['X'], dtype=float)
            y = np.array(a['y'], dtype=float)
            icpt = a.get('intercept', True)
            l2 = a.get('l2', 0)
            if a.get('maxIter') is not None:
                continue
            A = sm.add_constant(X, has_constant='add') if icpt else X
            colmax = np.abs(X).max(axis=0)
            if l2 == 0 and colmax.min() < 1e-6:
                # both libraries fail on features in units of 1e-9 (statsmodels does not
                # converge, sklearn stops 65 percent off); the witness fits the feature
                # rescaled to unit maximum and converts the coefficients back
                As = sm.add_constant(X / colmax, has_constant='add') if icpt else X / colmax
                res = sm.Logit(y, As).fit(method='newton', tol=1e-14, maxiter=200, disp=0)
                scale = np.concatenate([[1.0], colmax]) if icpt else colmax
                pin(c, 'coefficients', res.params / scale, 'statsmodels Logit on the feature rescaled to unit maximum, coefficients converted back')
                pin(c, 'standardErrors', res.bse / scale, 'statsmodels Logit bse, rescaled feature, converted back')
                pin(c, 'logLikelihood', float(res.llf), 'statsmodels Logit llf, rescaled feature')
                continue
            if l2 == 0:
                res = sm.Logit(y, A).fit(method='newton', tol=1e-14, maxiter=200, disp=0)
                pin(c, 'coefficients', res.params, 'statsmodels Logit (newton)')
                pin(c, 'standardErrors', res.bse, 'statsmodels Logit bse')
                pin(c, 'logLikelihood', float(res.llf), 'statsmodels Logit llf')
                if icpt:
                    pin(c, 'nullDeviance', float(-2 * res.llnull), 'statsmodels Logit -2 llnull')
            m = LogisticRegression(C=np.inf if l2 == 0 else 1.0 / l2, fit_intercept=icpt,
                                   solver='newton-cholesky', tol=1e-14, max_iter=1000).fit(X, y)
            coef = ([float(m.intercept_[0])] if icpt else []) + list(map(float, m.coef_[0]))
            pin(c, 'coefficients', coef, 'sklearn LogisticRegression newton-cholesky' + ('' if l2 == 0 else ', C = 1 / l2'))
        elif fn == 'solveSPD':
            A = np.array(a['A'], dtype=float)
            pin(c, 'x', np.linalg.solve(A, np.array(a['b'], dtype=float)), 'numpy.linalg.solve (LAPACK gesv)')
            dg = np.sqrt(np.diag(A))
            Ls = np.linalg.cholesky(A / np.outer(dg, dg))
            pin(c, 'minScaledPivot', float(np.min(np.diag(Ls)) ** 2) if A.shape[0] == 1 else float(min(np.diag(Ls) ** 2)), 'numpy.linalg.cholesky of the unit-diagonal scaling')
        elif fn == 'fitStandardScaler':
            X = np.array(a['X'], dtype=float)
            if 'trainIndices' in a:
                X = X[a['trainIndices']]
            pin(c, 'centre', X.mean(axis=0), 'numpy mean')
            pin(c, 'scale', X.std(axis=0, ddof=1 if a.get('sd') == 'sample' else 0), 'numpy std (ddof per sd)')
            if a.get('sd') != 'sample':
                pin(c, 'scale', StandardScaler().fit(X).scale_, 'sklearn StandardScaler')
        elif fn == 'fitMinMaxScaler':
            X = np.array(a['X'], dtype=float)
            if 'trainIndices' in a:
                X = X[a['trainIndices']]
            s = MinMaxScaler().fit(X)
            pin(c, 'min', s.data_min_, 'sklearn MinMaxScaler.data_min_')
            pin(c, 'max', s.data_max_, 'sklearn MinMaxScaler.data_max_')
        elif fn == 'applyScaler':
            sc = a['scaler']
            X = np.array(a['X'], dtype=float)
            pin(c, 'X', (X - np.array(sc['centre'])) / np.array(sc['scale']), 'numpy broadcast')
        elif fn == 'regressionMetrics':
            yt, yp = np.array(a['yTrue']), np.array(a['yPred'])
            pin(c, 'rmse', float(np.sqrt(mean_squared_error(yt, yp))), 'sklearn mean_squared_error')
            pin(c, 'mae', float(mean_absolute_error(yt, yp)), 'sklearn mean_absolute_error')
            if 'referenceMean' not in a:
                pin(c, 'r2', float(r2_score(yt, yp)), 'sklearn r2_score')
        elif fn == 'confusionMatrix':
            pin(c, 'matrix', confusion_matrix(a['yTrue'], a['yPred'], labels=e['labels']), 'sklearn confusion_matrix')
        elif fn == 'classificationReport':
            zd = a.get('zeroDivision', 0)
            labs = e['labels']
            p, r, f, s = precision_recall_fscore_support(a['yTrue'], a['yPred'], labels=labs, zero_division=zd)
            pin(c, 'perClass', [{'precision': float(p[i]), 'recall': float(r[i]), 'f1': float(f[i]), 'support': int(s[i])} for i in range(len(labs))],
                'sklearn precision_recall_fscore_support(average=None)')
            for avg in ('macro', 'weighted'):
                p, r, f, _ = precision_recall_fscore_support(a['yTrue'], a['yPred'], labels=labs, average=avg, zero_division=zd)
                pin(c, avg, {'precision': float(p), 'recall': float(r), 'f1': float(f)}, f'sklearn precision_recall_fscore_support(average={avg})')
            pin(c, 'accuracy', float(accuracy_score(a['yTrue'], a['yPred'])), 'sklearn accuracy_score')
        elif fn == 'rocCurve':
            fpr, tpr, _ = roc_curve(a['yTrue'], a['scores'], drop_intermediate=False)
            pin(c, 'fpr', fpr, 'sklearn roc_curve(drop_intermediate=False)')
            pin(c, 'tpr', tpr, 'sklearn roc_curve(drop_intermediate=False)')
            pin(c, 'auc', float(roc_auc_score(a['yTrue'], a['scores'])), 'sklearn roc_auc_score')
        elif fn == 'logLoss':
            eps = a.get('eps', 1e-15)
            yt = np.array(a['yTrue'], dtype=float)
            p = np.clip(np.array(a['probabilities'], dtype=float), eps, 1 - eps)
            pin(c, 'logLoss', float(-np.mean(yt * np.log(p) + (1 - yt) * np.log(1 - p))), 'numpy on np.clip(p, eps, 1 - eps)')
            raw = np.array(a['probabilities'], dtype=float)
            if np.all((raw >= eps) & (raw <= 1 - eps)):
                pin(c, 'logLoss', float(log_loss(yt, raw)), 'sklearn log_loss (no clipping needed)')
        elif fn in ('learningCurve', 'leakageDemo'):
            X = np.array(a['X'], dtype=float)
            y = np.array(a['y'], dtype=float)
            spec = a['model']
            metric = a.get('metric', 'auc' if spec['kind'] == 'logistic' else 'r2')

            def fit_score(tr, te):
                Xtr, ytr, Xte, yte = X[tr], y[tr], X[te], y[te]
                if spec['kind'] == 'ols':
                    b = sm.OLS(ytr, sm.add_constant(Xtr, has_constant='add')).fit(method='qr').params
                    f = lambda Z: sm.add_constant(Z, has_constant='add') @ b
                elif spec['kind'] == 'ridge':
                    sc = StandardScaler().fit(Xtr)
                    m = Ridge(alpha=spec['lambda'], solver='svd').fit(sc.transform(Xtr), ytr)
                    f = lambda Z: m.predict(sc.transform(Z))
                else:
                    l2 = spec.get('l2', 0)
                    m = LogisticRegression(C=np.inf if l2 == 0 else 1.0 / l2, solver='newton-cholesky', tol=1e-14, max_iter=1000).fit(Xtr, ytr)
                    f = lambda Z: m.predict_proba(Z)[:, 1]

                def score(Z, t):
                    v = f(Z)
                    if metric == 'r2':
                        return float(r2_score(t, v))
                    if metric == 'rmse':
                        return float(np.sqrt(mean_squared_error(t, v)))
                    if metric == 'mae':
                        return float(mean_absolute_error(t, v))
                    return float(roc_auc_score(t, v))
                return score(Xtr, ytr), score(Xte, yte)
            if fn == 'learningCurve':
                te = e['testIndices']
                for k, pt in enumerate(e['points']):
                    use = set(pt['groups'])
                    tr = [i for i, g in enumerate(a['groups']) if g in use]
                    s_tr, s_te = fit_score(tr, te)
                    pin(c, f'points.{k}.trainScore', s_tr, f'{spec["kind"]} refit by the library on the oracle split')
                    pin(c, f'points.{k}.testScore', s_te, f'{spec["kind"]} refit by the library on the oracle split')
            else:
                for side in ('randomRow', 'group'):
                    s_tr, s_te = fit_score(e[side]['trainIndices'], e[side]['testIndices'])
                    pin(c, f'{side}.trainScore', s_tr, f'{spec["kind"]} refit by the library on the oracle split')
                    pin(c, f'{side}.testScore', s_te, f'{spec["kind"]} refit by the library on the oracle split')

    out = {
        'module': 'ml',
        'generatedBy': 'tools/validation/dataai/pin_ml.py',
        'versions': {'numpy': np.__version__, 'scipy': scipy.__version__, 'scikit-learn': sklearn.__version__, 'statsmodels': statsmodels.__version__},
        'note': 'second witness on the golden inputs; the stdlib oracle is the first. Each tol is the library\'s own disagreement with the oracle x 10, rounded up to a power of ten, and at least 1e-10.',
        'pins': pins,
    }
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with open(DEST, 'w') as fh:
        json.dump(out, fh, indent=1, allow_nan=False)
        fh.write('\n')
    print('wrote', os.path.relpath(DEST), len(pins), 'pins')
    print('worst relative disagreement, library vs stdlib oracle, by function:')
    for k, v in sorted(worst.items()):
        print(f'  {k:24s} {v:.2e}')
    print('library results not pinned (not finite, or more than 1e-2 from the exact value):')
    for t in skipped:
        print('  ', t)
    loose = sorted({(p['case'], p['field'], p['tol']) for p in pins if p['tol'] > 1e-8}, key=lambda t: -t[2])
    print('pins looser than 1e-8 (the library is the less accurate witness there):')
    for t in loose:
        print('  ', t)


if __name__ == '__main__':
    main()
