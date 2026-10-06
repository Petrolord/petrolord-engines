"""Dev-time cross-check: goldens.inclusion.json against rockphypy's EM.PQ
(oblate and spherical pores) and against scipy's adaptive odeint driving
that P and Q for the differential effective medium. Not run in CI.

Two rockphypy defects found 2026-10-06, so neither path is used as-is:
  * EM.PQ prolate branch uses 1/cosh(alpha) where the published form has
    arccosh(alpha) (RPH 4.8): prolate cases are skipped.
  * EM.DEM calls PQ(G_eff, K_eff, ...) with bulk and shear swapped and
    drops the inclusion shear modulus: Berryman_DEM is not used; the ODE
    (RPH 4.11.1-2) is written here and integrated by odeint instead.
"""
import numpy as np
from scipy.integrate import odeint
import json
import os
import sys

from rockphypy import EM

here = os.path.dirname(os.path.abspath(__file__))
g = json.load(open(os.path.join(here, '..', '..', '..', 'test-data', 'rockphysics', 'goldens.inclusion.json')))
GPa = 1e9
worst = {}


def note(name, a, b):
    worst[name] = max(worst.get(name, 0.0), abs(a - b) / max(abs(a), abs(b)))


for r in g['pq']:
    if r['alpha'] > 1:
        continue
    P, Q = EM.PQ(r['Km'] / GPa, r['Gm'] / GPa, r['Ki'] / GPa, r['Gi'] / GPa, r['alpha'])
    note('PQ (oblate, sphere)', P, r['P']); note('PQ (oblate, sphere)', Q, r['Q'])
def dem_odeint(Km, Gm, inc, y):
    def rate(v, t):
        K, G = v
        dk = dg = 0.0
        for c in inc:
            P, Q = EM.PQ(K, G, c['K'] / GPa, c['G'] / GPa, c['alpha'])
            dk += c['w'] * (c['K'] / GPa - K) * P
            dg += c['w'] * (c['G'] / GPa - G) * Q
        return [dk / (1 - t), dg / (1 - t)]
    sol = odeint(rate, [Km / GPa, Gm / GPa], [0.0, y], rtol=1e-12, atol=1e-12)
    return sol[-1][0] * GPa, sol[-1][1] * GPa


for r in g['dem']:
    k, s_ = dem_odeint(r['Km'], r['Gm'], r['inclusions'], r['y'])
    note('DEM (odeint)', k, r['K']); note('DEM (odeint)', s_, r['G'])
bad = False
for n, w in worst.items():
    print(f'{n:22s} worst rel diff {w:.3e}')
bad = worst['PQ (oblate, sphere)'] > 1e-12 or worst['DEM (odeint)'] > 1e-8
sys.exit(1 if bad else 0)
