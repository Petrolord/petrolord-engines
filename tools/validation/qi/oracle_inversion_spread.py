"""numpy oracle for engines/qi/inversionSpread.js quantiles (QI Q8a).

numpy.quantile with its default (linear, Hyndman and Fan type 7) on seeded
random sets, with NaN gaps left out per sample (numpy.nanquantile). Writes
test-data/qi/goldens.inversionSpread.json.
Usage: python -I oracle_inversion_spread.py <engines repo root>
"""
import json
import os
import sys
import numpy as np

root = sys.argv[1]
rng = np.random.default_rng(7)
R = np.round(rng.normal(8.5, 0.3, size=(9, 40)), 6)
R[2, 5] = np.nan
R[:, 7] = np.nan
qs = [0.1, 0.5, 0.9]
Q = [np.nanquantile(R, q, axis=0) for q in qs]
# anchors: the median of 1..9 is 5; the 10th percentile of 1..9 is 1.8
assert np.isclose(np.quantile(np.arange(1, 10), 0.5), 5)
assert np.isclose(np.quantile(np.arange(1, 10), 0.1), 1.8)
out = {
    'realisations': [[None if np.isnan(v) else float(v) for v in r] for r in R],
    'qs': qs,
    'quantiles': [[None if np.isnan(v) else float(v) for v in q] for q in Q],
}
with open(os.path.join(root, 'test-data/qi/goldens.inversionSpread.json'), 'w') as f:
    json.dump(out, f)
print('wrote goldens.inversionSpread.json')
