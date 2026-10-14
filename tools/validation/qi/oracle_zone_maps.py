"""Oracle for engines/qi/zoneMaps.js (QI upgrade P1.5, zone maps from volumes).

Independent of the engine's loops: numpy masks and reductions over the zone
window. Window convention (Seismolord's A-to-B interval attributes): samples
from round(min(top, base)) to round(max(top, base)), clamped to the trace,
with JavaScript's Math.round (half up: floor(x + 0.5)); numpy's round is
banker's rounding, so it is not used. Null samples (|v| > 1e29) never count.

Anchors asserted in main(): a linear trace a + b k has the zone mean
a + b (s0 + s1) / 2 exactly and the closed-form RMS; the share above a
cutoff on a linear trace is a count; a constant spread gives that spread.
Writes test-data/qi/goldens.zoneMaps.json.
"""
import json
import math
import os
import numpy as np


def js_round(x):
    return math.floor(x + 0.5)


def window(top, base, ns, win=None):
    if base is None:
        base = top + win
    s0 = max(0, js_round(min(top, base)))
    s1 = min(ns - 1, js_round(max(top, base)))
    return (s0, s1) if s1 >= s0 else None


def stats(trace, s0, s1, cutoff=None, above=True):
    seg = np.asarray(trace[s0:s1 + 1], dtype=float)
    live = seg[np.abs(seg) <= 1e29]
    if live.size == 0:
        return None
    out = {
        'n': int(live.size),
        'mean': float(np.mean(live)),
        'rms': float(np.sqrt(np.mean(live ** 2))),
        'min': float(np.min(live)),
        'max': float(np.max(live)),
    }
    out['frac'] = None if cutoff is None else float(np.mean(live > cutoff) if above else np.mean(live < cutoff))
    return out


def spread(q10, q50, q90, s0, s1):
    a = np.asarray(q10[s0:s1 + 1], float); m = np.asarray(q50[s0:s1 + 1], float); b = np.asarray(q90[s0:s1 + 1], float)
    ok = (np.abs(a) <= 1e29) & (np.abs(m) <= 1e29) & (np.abs(b) <= 1e29)
    okr = ok & (m != 0)
    return {
        'n': int(ok.sum()),
        'spread': float(np.mean((b - a)[ok])) if ok.any() else None,
        'relSpread': float(np.mean(((b - a) / np.where(m == 0, 1, m))[okr])) if okr.any() else None,
    }


def main():
    # anchors
    ns = 200
    a, b = 0.3, 0.002
    lin = [a + b * k for k in range(ns)]
    s0, s1 = window(40.4, 90.6, ns)
    assert (s0, s1) == (40, 91)
    st = stats(lin, s0, s1, cutoff=a + b * 70.5)
    assert abs(st['mean'] - (a + b * (s0 + s1) / 2)) < 1e-12
    n = s1 - s0 + 1
    rms = math.sqrt(sum((a + b * k) ** 2 for k in range(s0, s1 + 1)) / n)
    assert abs(st['rms'] - rms) < 1e-12
    assert abs(st['frac'] - (s1 - 70) / n) < 1e-12
    assert window(10.5, None, ns, win=20) == (11, 31)  # half up, unlike numpy
    c = spread([1.0] * ns, [2.0] * ns, [1.5] * ns, 0, ns - 1)
    assert abs(c['spread'] - 0.5) < 1e-12 and abs(c['relSpread'] - 0.25) < 1e-12

    rng = np.random.default_rng(20261015)
    cases = []
    for i in range(12):
        ns = int(rng.integers(60, 240))
        tr = rng.normal(0.25, 0.08, ns)
        nulls = rng.random(ns) < 0.1
        tr[nulls] = 1e30
        top = float(rng.uniform(-5, ns * 0.6))
        use_base = i % 3 != 2
        base = float(top + rng.uniform(-10, 60)) if use_base else None
        win = None if use_base else float(rng.uniform(3, 40))
        w = window(top, base, ns, win)
        cutoff = float(rng.uniform(0.15, 0.35))
        q10 = tr - rng.uniform(0.01, 0.05, ns); q90 = tr + rng.uniform(0.01, 0.05, ns)
        q10[nulls] = 1e30; q90[nulls] = 1e30
        case = {
            'ns': ns, 'trace': [float(v) for v in tr], 'q10': [float(v) for v in q10], 'q90': [float(v) for v in q90],
            'top': top, 'base': base, 'window': win, 'cutoff': cutoff, 'range': list(w) if w else None,
            'stats': stats(tr, *w, cutoff=cutoff) if w else None,
            'statsBelow': stats(tr, *w, cutoff=cutoff, above=False) if w else None,
            'spread': spread(q10, tr, q90, *w) if w else None,
        }
        cases.append(case)
    out = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'test-data', 'qi', 'goldens.zoneMaps.json')
    with open(out, 'w') as f:
        json.dump({'source': 'tools/validation/qi/oracle_zone_maps.py', 'cases': cases}, f)
    print('wrote', len(cases), 'cases')


if __name__ == '__main__':
    main()
