"""Oracle for engines/qi/lfmModels.js (QI upgrade P2.8).

Ordinary-kriging weights solved with numpy.linalg.solve on the (n + 1)
system [[C, 1], [1^T, 0]] [w; mu] = [c0; 1], with the covariance forms of
lib/gridding/kriging.js written out here (spherical, exponential, gaussian:
C(h) = (sill - nugget) corr(h), C(0) = sill); Dix interval velocities from an
RMS function sampled every dt from zero, computed in closed form from the
layer velocities that made it. Anchors: weights sum to one; four symmetric
wells give 0.25 each; a well at the target gets weight one.
Writes test-data/qi/goldens.lfmModels.json.
"""
import json
import math
import os
import numpy as np


def corr(h, model, rng):
    if h <= 0:
        return 1.0
    if model == 'spherical':
        if h >= rng:
            return 0.0
        u = h / rng
        return 1 - (1.5 * u - 0.5 * u ** 3)
    if model == 'exponential':
        return math.exp(-3 * h / rng)
    return math.exp(-3 * h * h / (rng * rng))


def cov(h, v):
    return v['sill'] if h <= 0 else (v['sill'] - v.get('nugget', 0)) * corr(h, v['model'], v['range'])


def ok_weights(pts, at, v):
    n = len(pts)
    A = np.zeros((n + 1, n + 1)); b = np.zeros(n + 1)
    for i in range(n):
        for j in range(n):
            A[i, j] = cov(math.dist(pts[i], pts[j]), v)
        A[i, n] = A[n, i] = 1
        b[i] = cov(math.dist(pts[i], at), v)
    b[n] = 1
    return np.linalg.solve(A, b)[:n]


def main():
    sym = [(0, 0), (100, 0), (0, 100), (100, 100)]
    w = ok_weights(sym, (50, 50), {'model': 'spherical', 'range': 400, 'sill': 1})
    assert np.allclose(w, 0.25)
    rng = np.random.default_rng(15)
    cases = []
    for model in ('spherical', 'exponential', 'gaussian'):
        for k in range(3):
            n = int(rng.integers(3, 7))
            pts = [(float(x), float(y)) for x, y in rng.uniform(0, 2000, (n, 2))]
            at = tuple(float(x) for x in rng.uniform(0, 2000, 2))
            v = {'model': model, 'range': float(rng.uniform(800, 3000)), 'sill': 1.0, 'nugget': float(rng.uniform(0, 0.3))}
            wk = ok_weights(pts, at, v)
            assert abs(wk.sum() - 1) < 1e-12
            cases.append({'pts': pts, 'at': at, 'variogram': v, 'weights': [float(x) for x in wk]})
    # Dix: layers of interval velocity, sampled RMS every dt from 0
    dt = 4.0
    layers = [(0, 1600.0), (60, 2100.0), (140, 2600.0), (230, 3100.0)]  # (first sample, velocity)
    ns = 300
    vint = np.zeros(ns)
    for i in range(ns):
        vint[i] = [v for s, v in layers if i >= s][-1]
    # RMS at sample i over the interval [0, t_i] (sample 0's interval is its own value)
    vrms = np.zeros(ns); vrms[0] = vint[0]
    acc = 0.0
    for i in range(1, ns):
        acc += vint[i] ** 2 * dt
        vrms[i] = math.sqrt((vint[0] ** 2 * 0 + acc) / (i * dt))
    out = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'test-data', 'qi', 'goldens.lfmModels.json')
    with open(out, 'w') as f:
        json.dump({'source': 'tools/validation/qi/oracle_lfm_models.py', 'kriging': cases, 'dix': {'dt_ms': dt, 'vrms': [float(x) for x in vrms], 'vint': [float(x) for x in vint]}}, f)
    print('wrote', len(cases), 'kriging cases and the Dix trace')


if __name__ == '__main__':
    main()
