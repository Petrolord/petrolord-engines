"""scipy oracle for engines/qi/propertyPrediction.js (QI Q9a).

  * linear transform: scipy.stats.linregress, and the prediction interval of
    a new observation, t.ppf(0.9, n - 2) * s * sqrt(1 + 1/n + (x0 - xbar)^2 / Sxx);
  * Bayesian facies: scipy.stats.multivariate_normal (Gaussian) and
    scipy.stats.gaussian_kde (Scott's rule) per class, priors from the class
    counts, posterior = prior * density / sum.
Seeded two- and three-class sets in 1D (AI) and 2D (AI, Vp/Vs).
Writes test-data/qi/goldens.propertyPrediction.json.
Usage: python -I oracle_property_prediction.py <engines repo root>
"""
import json
import os
import sys
import numpy as np
from scipy import stats

root = sys.argv[1]
rng = np.random.default_rng(42)

# linear transform: porosity from AI
ai = np.round(rng.uniform(5000, 9000, 40), 3)
phi = np.round(0.42 - 3.6e-5 * ai + rng.normal(0, 0.012, 40), 6)
lr = stats.linregress(ai, phi)
n = len(ai)
resid = phi - (lr.intercept + lr.slope * ai)
s = np.sqrt(np.sum(resid ** 2) / (n - 2))
sxx = np.sum((ai - ai.mean()) ** 2)
x0 = [5200.0, 7000.0, 8800.0, 10000.0]
t = stats.t.ppf(0.9, n - 2)
pred = []
for x in x0:
    y = lr.intercept + lr.slope * x
    h = t * s * np.sqrt(1 + 1 / n + (x - ai.mean()) ** 2 / sxx)
    pred.append({'x': x, 'y': y, 'lo': y - h, 'hi': y + h})

def classes(d):
    if d == 1:
        spec = [('shale', [7600.0], [[400.0 ** 2]], 60), ('brine sand', [6900.0], [[350.0 ** 2]], 40), ('gas sand', [5900.0], [[300.0 ** 2]], 20)]
    else:
        spec = [('shale', [7600.0, 2.1], [[400.0 ** 2, 20.0], [20.0, 0.08 ** 2]], 60),
                ('brine sand', [6900.0, 1.95], [[350.0 ** 2, 10.0], [10.0, 0.07 ** 2]], 40),
                ('gas sand', [5900.0, 1.65], [[300.0 ** 2, 5.0], [5.0, 0.06 ** 2]], 20)]
    out = []
    for name, mu, cov, k in spec:
        x = np.round(rng.multivariate_normal(mu, cov, k), 6)
        out.append((name, x))
    return out

def posteriors(cls, queries, kind):
    total = sum(len(x) for _, x in cls)
    res = []
    for q in queries:
        lp = []
        for name, x in cls:
            prior = len(x) / total
            if kind == 'gaussian':
                dens = stats.multivariate_normal(mean=x.mean(axis=0), cov=np.atleast_2d(np.cov(x, rowvar=False))).pdf(q)
            else:
                dens = stats.gaussian_kde(x.T)(np.atleast_2d(q).T)[0]
            lp.append(prior * dens)
        lp = np.array(lp)
        res.append((lp / lp.sum()).tolist())
    return res

sets = []
for d in (1, 2):
    cls = classes(d)
    queries = [[6000.0], [6950.0], [7500.0]] if d == 1 else [[6000.0, 1.7], [6950.0, 1.95], [7500.0, 2.05], [6400.0, 1.8]]
    sets.append({
        'dims': d,
        'samples': [{'facies': name, 'x': row.tolist()} for name, x in cls for row in x],
        'queries': queries,
        'gaussian': posteriors(cls, queries, 'gaussian'),
        'kde': posteriors(cls, queries, 'kde'),
    })

# anchors: equal 1D Gaussians with equal priors give 0.5 at the midpoint
a = stats.norm(0, 1).pdf(0.5); b = stats.norm(1, 1).pdf(0.5)
assert np.isclose(a / (a + b), 0.5)
out = {'transform': {'x': ai.tolist(), 'y': phi.tolist(), 'a': lr.intercept, 'b': lr.slope, 's': s, 'r2': lr.rvalue ** 2, 'pred': pred}, 'sets': sets}
with open(os.path.join(root, 'test-data/qi/goldens.propertyPrediction.json'), 'w') as f:
    json.dump(out, f)
print('wrote goldens.propertyPrediction.json')
