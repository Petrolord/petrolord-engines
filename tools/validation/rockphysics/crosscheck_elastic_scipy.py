"""Dev-time cross-check: goldens.elastic.json regression against numpy least
squares and scipy's Student t (the prediction interval recomputed from
scratch). Not run in CI."""
import json, os, sys
import numpy as np
from scipy import stats

here = os.path.dirname(os.path.abspath(__file__))
g = json.load(open(os.path.join(here, '..', '..', '..', 'test-data', 'rockphysics', 'goldens.elastic.json')))
pts = np.array([[p['vp'], p['vs']] for p in g['regression']['samples']])
worst = 0.0
for form, cols in (('linear', 2), ('quadratic', 3)):
    x = pts[:, 0] / 1000
    X = np.vstack([x ** k for k in range(cols)]).T
    coef, *_ = np.linalg.lstsq(X, pts[:, 1], rcond=None)
    dof = len(pts) - cols
    s = np.sqrt(np.sum((pts[:, 1] - X @ coef) ** 2) / dof)
    inv = np.linalg.inv(X.T @ X)
    t = stats.t.ppf(0.95, dof)
    gg = g['regression'][form]
    worst = max(worst, max(abs(a - b) / abs(b) for a, b in zip(gg['coef'], coef)), abs(gg['s'] - s) / s)
    for p in gg['predictions']:
        x0 = np.array([(p['vp'] / 1000) ** k for k in range(cols)])
        f = x0 @ coef
        sig = s * np.sqrt(1 + x0 @ inv @ x0)
        for k, v in (('vs', f), ('sigma', sig), ('lo', f - t * sig), ('hi', f + t * sig)):
            worst = max(worst, abs(p[k] - v) / abs(v))
print(f'regression and prediction interval: worst rel diff {worst:.3e}')
sys.exit(1 if worst > 1e-6 else 0)
