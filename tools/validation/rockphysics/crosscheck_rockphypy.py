"""Dev-time cross-check: goldens.granular.json against rockphypy (published
open-source implementation of the same RPH models). Not run in CI; rockphypy
is not a dependency. Usage: python crosscheck_rockphypy.py (with rockphypy
installed). Prints the worst relative difference per model; exits 1 above 1e-9.
"""
import json
import os
import sys

from rockphypy import GM, Fluid

here = os.path.dirname(os.path.abspath(__file__))
g = json.load(open(os.path.join(here, '..', '..', '..', 'test-data', 'rockphysics', 'goldens.granular.json')))
GPa = 1e9
SCHEME = {'contact': 1, 'surface': 2}


def rel(a, b):
    return abs(a - b) / max(abs(a), abs(b), 1e-30)


worst = {}


def note(name, a, b):
    worst[name] = max(worst.get(name, 0.0), rel(a, b))


for r in g['hertzMindlin']:
    k, s = GM.hertzmindlin(r['K'] / GPa, r['G'] / GPa, r['phiC'], r['n'], r['P'] / 1e6, r['f'])  # rockphypy stress is in MPa
    note('hertzMindlin', k * GPa, r['k']); note('hertzMindlin', s * GPa, r['g'])
for key, fn in (('softSand', GM.softsand), ('stiffSand', GM.stiffsand)):
    for r in g[key]:
        k, s = fn(r['K'] / GPa, r['G'] / GPa, r['phi'], r['phiC'], r['n'], r['P'] / 1e6, 1)
        note(key, k * GPa, r['k']); note(key, s * GPa, r['g'])
for r in g['contactCement']:
    k, s = GM.contactcement(r['K'] / GPa, r['G'] / GPa, r['Kc'] / GPa, r['Gc'] / GPa, r['phi'], r['phi0'], r['n'], SCHEME[r['scheme']])
    note('contactCement', k * GPa, r['k']); note('contactCement', s * GPa, r['g'])
for r in g['constantCement']:
    k, s = GM.constantcement(r['phiB'], r['K'] / GPa, r['G'] / GPa, r['Kc'] / GPa, r['Gc'] / GPa, r['phi'], r['phi0'], r['n'], SCHEME[r['scheme']])
    note('constantCement', k * GPa, r['k']); note('constantCement', s * GPa, r['g'])
for r in g['brie']:
    note('brie', Fluid.Brie(r['kLiquid'], r['kGas'], r['sw'], r['e']), r['k'])

bad = False
for name, w in worst.items():
    print(f'{name:16s} worst rel diff {w:.3e}')
    bad = bad or w > 1e-9
sys.exit(1 if bad else 0)
