#!/usr/bin/env python3
"""Second-witness pins for engines/dataai/forecast.js (Data & AI D4).

Needs numpy, scipy, statsmodels and scikit-learn (the library witness, NOT
the stdlib oracle):

    /root/daienv/bin/python tools/validation/dataai/pin_forecast.py

It reads the INPUTS of the golden cases and writes
test-data/dataai/pins/forecast_pins.json. A library result is pinned only
where it agrees with the oracle (numbers to 1e-4 relative); every
disagreement is listed in `skipped` with its reason, and
FINDINGS-forecast.md explains each convention difference. Each numeric pin's
tolerance is max(1e-10, 10 x the library's own disagreement with the
oracle), rounded up to a power of ten.

Mappings stated once:
  recursions   statsmodels ExponentialSmoothing on y[1:] with
               initialization_method='known', initial_level = l_1,
               initial_trend = b_1 (the engine's state at the first
               observation is statsmodels' state before its first value),
               trend='add' for holt and damped, damped_trend=True for
               damped, fit(smoothing_level, smoothing_trend, damping_trend,
               optimized=False). fittedvalues = the engine's fitted[1:],
               level = level[1:], trend = trend[1:], forecast(h).
               statsmodels' sse sums every residual; the engine does not
               score y_2 under the default trend start (holt: that residual
               is 0 by construction; damped: it is (1 - phi) b_1), so the
               SSE pin is the sum of squares of the statsmodels residuals
               the engine scores.
  fit          scipy.optimize.minimize(method='L-BFGS-B', the engine's
               bounds) of the engine's objective (the scored SSE from the
               statsmodels recursions) from the oracle's grid start. The
               engine's SSE must be no worse ('atMost', relative 1e-9);
               parameters are pinned where L-BFGS-B lands within 1e-4 of the
               oracle. statsmodels' own optimiser (fit()) is recorded as
               well: pinned where it agrees within 1e-4, otherwise listed in
               `skipped` with its SSE against the engine's (it holds
               beta <= alpha, a smaller box than the engine's).
  metrics      sklearn mean_absolute_error, root_mean_squared_error,
               mean_absolute_percentage_error x 100 (only without zero
               actuals: sklearn divides by max(|y|, eps)).
  backtest     statsmodels on each training window with the fixed
               parameters: the per-origin forecasts.
  intervals    the point forecasts only (no library shares the
               mulberry32 draws).
  Arps         no library pin: engines/dca fitArpsModel's linearised fits
               are its own algorithm (the oracle replays it).
"""
import json
import math
import os
import warnings

os.environ.setdefault('OMP_NUM_THREADS', '1')

import numpy as np
import scipy
import sklearn
import statsmodels
from scipy.optimize import minimize
from sklearn.metrics import mean_absolute_error, mean_absolute_percentage_error, root_mean_squared_error
from statsmodels.tsa.holtwinters import ExponentialSmoothing

warnings.simplefilter('ignore')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '..')
GOLD = os.path.join(ROOT, 'test-data', 'dataai', 'goldens', 'forecast_cases.json')
DEST = os.path.join(ROOT, 'test-data', 'dataai', 'pins', 'forecast_pins.json')
TOL = 1e-10
AGREE = 1e-4
BOUNDS = {'alpha': (0.0, 1.0), 'beta': (0.0, 1.0), 'phi': (0.8, 0.98)}


def up10(x):
    return 10.0 ** math.ceil(math.log10(x)) if x > 0 else 0.0


def get(obj, dotted):
    for k in dotted.split('.'):
        obj = obj[int(k)] if isinstance(obj, list) else obj[k]
    return obj


def sm_fit(y, method, alpha, beta, phi, l1, b1):
    kw = {'initialization_method': 'known', 'initial_level': l1}
    if method != 'ses':
        kw.update(trend='add', initial_trend=b1, damped_trend=(method == 'damped'))
    m = ExponentialSmoothing(np.asarray(y[1:], dtype=float), **kw)
    fk = {'smoothing_level': alpha, 'optimized': False}
    if method != 'ses':
        fk['smoothing_trend'] = beta
    if method == 'damped':
        fk['damping_trend'] = phi
    return m.fit(**fk)


def starts(a, method):
    l1 = a.get('initialLevel', a['y'][0])
    b1 = None if method == 'ses' else a.get('initialTrend', a['y'][1] - a['y'][0])
    scored = 1 if (method == 'ses' or 'initialTrend' in a) else 2
    return l1, b1, scored


def main():
    G = json.load(open(GOLD))
    pins, skipped = [], []
    worst = {}

    def pin(case, field, lib, what, expected=None, frm=None, compare=None, tol=None):
        e = case['expected'] if expected is None else expected
        ev = get(e, field) if expected is None else expected
        if frm is not None:
            ev = ev[frm:]
        lv = np.asarray(lib, dtype=float).tolist() if not isinstance(lib, (int, float)) else float(lib)
        if compare == 'atMost':
            pins.append({'id': f"{case['id']}:{field}:atMost", 'case': case['id'], 'field': field, 'value': lv, 'tol': tol, 'compare': 'atMost', 'library': what})
            return
        ea = np.atleast_1d(np.asarray(ev, dtype=float))
        la = np.atleast_1d(np.asarray(lv, dtype=float))
        if ea.shape != la.shape:
            skipped.append([case['id'], field, f'{what}: shape {la.shape} vs {ea.shape}'])
            return
        rel = float(np.max(np.abs(la - ea) / np.maximum(np.abs(ea), 1e-300))) if ea.size else 0.0
        absd = float(np.max(np.abs(la - ea))) if ea.size else 0.0
        d = min(rel, absd)
        if d > AGREE:
            skipped.append([case['id'], field, f'{what} differs from the oracle by {rel:.3g} relative'])
            return
        worst[case['fn']] = max(worst.get(case['fn'], 0.0), d)
        p = {'id': f"{case['id']}:{field}", 'case': case['id'], 'field': field, 'value': lv,
             'tol': max(TOL, up10(10 * rel)), 'abs': max(1e-9, up10(10 * absd)), 'library': what}
        if frm is not None:
            p['from'] = frm
        pins.append(p)

    for c in G['cases']:
        e = c['expected']
        if isinstance(e, dict) and e.get('error'):
            continue
        a = c['args']
        fn = c['fn']
        if fn == 'fitSmoothing':
            method = a['method']
            l1, b1, scored = starts(a, method)
            p = e['params']
            try:
                f = sm_fit(a['y'], method, p['alpha'], p.get('beta'), p.get('phi'), l1, b1)
            except NotImplementedError as ex:
                skipped.append([c['id'], '*', f'statsmodels refuses a series of {len(a["y"]) - 1} value(s) after the first: {ex}'])
                continue
            if not e['free']:
                pin(c, 'fitted', f.fittedvalues, 'statsmodels ExponentialSmoothing fittedvalues (known start)', frm=1)
                pin(c, 'level', f.level, 'statsmodels level', frm=1)
                if method != 'ses':
                    pin(c, 'trend', f.trend, 'statsmodels trend', frm=1)
                if a.get('h', 0) > 0:
                    pin(c, 'forecast', f.forecast(a['h']), 'statsmodels forecast(h)')
                res = np.asarray(a['y'][1:], dtype=float) - f.fittedvalues
                pin(c, 'sse', float(np.sum(res[scored - 1:] ** 2)), 'sum of squares of the statsmodels residuals the engine scores')
            else:
                free = e['free']
                fixed = {k: v for k, v in p.items() if k not in free}
                y = a['y']

                def obj(x):
                    q = dict(fixed)
                    q.update(dict(zip(free, x)))
                    r = sm_fit(y, method, q['alpha'], q.get('beta'), q.get('phi'), l1, b1)
                    res = np.asarray(y[1:], dtype=float) - r.fittedvalues
                    return float(np.sum(res[scored - 1:] ** 2))
                x0 = [e['optimiser']['gridStart'][k] for k in free]
                o = minimize(obj, x0, method='L-BFGS-B', bounds=[BOUNDS[k] for k in free], options={'ftol': 1e-15, 'gtol': 1e-10, 'maxiter': 5000})
                pin(c, 'sse', float(o.fun), 'scipy L-BFGS-B minimum of the scored SSE (statsmodels recursions)', compare='atMost', tol=1e-9)
                for k, v in zip(free, o.x):
                    pin(c, f'params.{k}', float(v), 'scipy L-BFGS-B minimiser')
                if method == 'ses' and scored == 1 and 'initialLevel' not in a:
                    s = ExponentialSmoothing(np.asarray(y[1:], dtype=float), initialization_method='known', initial_level=l1).fit()
                    pin(c, 'params.alpha', float(s.params['smoothing_level']), 'statsmodels SimpleExpSmoothing optimiser (own)')
                elif method in ('holt', 'damped'):
                    kw = {'initialization_method': 'known', 'initial_level': l1, 'trend': 'add', 'initial_trend': b1, 'damped_trend': method == 'damped',
                          'bounds': {'smoothing_level': BOUNDS['alpha'], 'smoothing_trend': BOUNDS['beta'], **({'damping_trend': BOUNDS['phi']} if method == 'damped' else {})}}
                    held = {{'alpha': 'smoothing_level', 'beta': 'smoothing_trend', 'phi': 'damping_trend'}[k]: v for k, v in fixed.items()}
                    s = ExponentialSmoothing(np.asarray(y[1:], dtype=float), **kw).fit(**held)
                    sa, sb = float(s.params['smoothing_level']), float(s.params['smoothing_trend'])
                    res = np.asarray(y[1:], dtype=float) - s.fittedvalues
                    s_sse = float(np.sum(res[scored - 1:] ** 2))
                    sp = float(s.params['damping_trend']) if method == 'damped' else None
                    if any(abs(float(s.params[{'alpha': 'smoothing_level', 'beta': 'smoothing_trend', 'phi': 'damping_trend'}[k]]) - v) > 1e-12 for k, v in fixed.items()):
                        skipped.append([c['id'], 'statsmodels own fit', 'statsmodels did not hold the fixed parameters'])
                    elif abs(sb - p['beta']) > AGREE or abs(sa - p['alpha']) > AGREE or (sp is not None and abs(sp - p['phi']) > AGREE):
                        why = 'at its beta <= alpha limit' if abs(sb - sa) < 1e-6 else 'at a different point'
                        skipped.append([c['id'], 'statsmodels own fit', f"statsmodels' own optimiser stops {why}: alpha {sa:.6g}, beta {sb:.6g}{'' if sp is None else f', phi {sp:.6g}'}, scored SSE {s_sse:.10g} against the engine's {e['sse']:.10g}"])
                    else:
                        for k in free:
                            pin(c, f'params.{k}', float(s.params[{'alpha': 'smoothing_level', 'beta': 'smoothing_trend', 'phi': 'damping_trend'}[k]]), 'statsmodels ExponentialSmoothing optimiser (own, same box)')
        elif fn == 'accuracy':
            y = np.asarray(a['actual'], dtype=float)
            fc = np.asarray(a['forecast'], dtype=float)
            pin(c, 'mae', mean_absolute_error(y, fc), 'sklearn mean_absolute_error')
            pin(c, 'rmse', root_mean_squared_error(y, fc), 'sklearn root_mean_squared_error')
            if e['mape'] is not None:
                pin(c, 'mape', 100 * mean_absolute_percentage_error(y, fc), 'sklearn mean_absolute_percentage_error x 100')
            else:
                skipped.append([c['id'], 'mape', 'a zero actual: sklearn divides by eps and returns a huge number; the engine reports null'])
        elif fn == 'backtest':
            method = a['method']
            given = {k: a[k] for k in ('alpha', 'beta', 'phi') if k in a}
            wanted = ['alpha'] if method == 'ses' else ['alpha', 'beta'] if method == 'holt' else ['alpha', 'beta', 'phi']
            if all(k in given for k in wanted):
                for i, row in enumerate(e['perOrigin']):
                    tr = a['y'][:row['origin']]
                    f = sm_fit(tr, method, given['alpha'], given.get('beta'), given.get('phi'), tr[0], None if method == 'ses' else tr[1] - tr[0])
                    pin(c, f'perOrigin.{i}.forecast', f.forecast(a['horizon']), 'statsmodels forecast on the training window')
        elif fn == 'forecastIntervals':
            method = a['method']
            l1, b1, _ = starts(a, method)
            p = e['params']
            f = sm_fit(a['y'], method, p['alpha'], p.get('beta'), p.get('phi'), l1, b1)
            pin(c, 'forecast', f.forecast(a['h']), 'statsmodels forecast(h) (the point forecast; draws are not shared)')

    out = {
        'generatedBy': 'tools/validation/dataai/pin_forecast.py',
        'versions': {'numpy': np.__version__, 'scipy': scipy.__version__, 'statsmodels': statsmodels.__version__, 'scikit-learn': sklearn.__version__},
        'pins': pins,
        'skipped': skipped,
    }
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with open(DEST, 'w') as fh:
        json.dump(out, fh, indent=1, allow_nan=False)
        fh.write('\n')
    print('wrote', os.path.relpath(DEST), len(pins), 'pins,', len(skipped), 'skipped')
    for fn, w in sorted(worst.items()):
        print(f'  {fn:20s} worst disagreement with the oracle {w:.2g}')
    for s in skipped:
        print('  SKIPPED', *s)


if __name__ == '__main__':
    main()
