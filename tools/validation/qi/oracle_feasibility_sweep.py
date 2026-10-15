"""Oracle for engines/qi/feasibilitySweep.js (QI upgrade P2.9).

Standard library only, written from the Rock Physics Handbook:
- Voigt-Reuss-Hill mineral mix (RPH 4.1), quartz 36.6/45.0 GPa 2650, clay 20.9/6.9 GPa 2580;
- Hertz-Mindlin at critical porosity (RPH 5.4.1-2) and the soft-sand
  modified lower Hashin-Shtrikman bound (RPH 5.4.5, Dvorkin and Nur 1996);
- Gassmann saturation (RPH 6.3);
- Backus averaging at normal incidence (RPH 4.13): harmonic means of the
  P-wave and shear moduli, arithmetic mean of density.
Anchors: Backus of identical layers is that layer; Backus lies at or below
the Voigt (arithmetic) average of the moduli. Writes
test-data/qi/goldens.feasibilitySweep.json.
"""
import json
import math
import os

Q = (36.6e9, 45.0e9, 2650.0)
C = (20.9e9, 6.9e9, 2580.0)


def vrh(fr, ms):
    v = sum(f * m for f, m in zip(fr, ms))
    r = 1 / sum(f / m for f, m in zip(fr, ms) if f > 0)
    return 0.5 * (v + r)


def mineral(vsh):
    fr = [1 - vsh, vsh] if vsh > 0 else [1.0]
    ks = [Q[0], C[0]][:len(fr)]; gs = [Q[1], C[1]][:len(fr)]; rs = [Q[2], C[2]][:len(fr)]
    return vrh(fr, ks), vrh(fr, gs), sum(f * r for f, r in zip(fr, rs))


def soft_sand(K, G, phi, phiC, n, P):
    nu = (3 * K - 2 * G) / (2 * (3 * K + G))
    base = n * n * (1 - phiC) ** 2 * G * G * P / (math.pi ** 2 * (1 - nu) ** 2)
    khm = (base / 18) ** (1 / 3)
    ghm = (5 - 4 * nu) / (5 * (2 - nu)) * (3 * base / 2) ** (1 / 3)
    a = phi / phiC
    kdry = 1 / (a / (khm + 4 / 3 * ghm) + (1 - a) / (K + 4 / 3 * ghm)) - 4 / 3 * ghm
    z = ghm / 6 * (9 * khm + 8 * ghm) / (khm + 2 * ghm)
    gdry = 1 / (a / (ghm + z) + (1 - a) / (G + z)) - z
    return kdry, gdry


def saturate(kdry, gdry, kmin, kfl, phi, rhomin, rhofl):
    ks = kdry + (1 - kdry / kmin) ** 2 / (phi / kfl + (1 - phi) / kmin - kdry / kmin ** 2)
    rho = (1 - phi) * rhomin + phi * rhofl
    return math.sqrt((ks + 4 / 3 * gdry) / rho), math.sqrt(gdry / rho), rho


def sand(phi, vsh, peff, kfl, rhofl, phiC=0.4, n=8):
    K, G, rho = mineral(vsh)
    kd, gd = soft_sand(K, G, phi, phiC, n, peff * 1e6)
    return saturate(kd, gd, K, kfl, phi, rho, rhofl)


def backus(layers):
    H = sum(h for h, *_ in layers)
    invM = sum(h / H / (r * vp * vp) for h, vp, vs, r in layers)
    invMu = sum(h / H / (r * vs * vs) for h, vp, vs, r in layers)
    rho = sum(h / H * r for h, vp, vs, r in layers)
    return math.sqrt(1 / invM / rho), math.sqrt(1 / invMu / rho), rho


def main():
    one = backus([(1, 3000, 1500, 2400), (2, 3000, 1500, 2400)])
    assert all(abs(a - b) < 1e-9 for a, b in zip(one, (3000, 1500, 2400)))
    two = backus([(0.6, 3200, 1800, 2300), (0.4, 2700, 1200, 2450)])
    voigt_m = 0.6 * 2300 * 3200 ** 2 + 0.4 * 2450 * 2700 ** 2
    assert two[2] * two[0] ** 2 <= voigt_m
    sands = []
    for phi, vsh, peff, kfl, rhofl in [(0.30, 0.0, 20, 2.6e9, 1030), (0.30, 0.0, 20, 0.08e9, 180), (0.22, 0.15, 25, 2.6e9, 1030), (0.25, 0.3, 12, 1.1e9, 750), (0.35, 0.05, 8, 0.05e9, 120)]:
        vp, vs, rho = sand(phi, vsh, peff, kfl, rhofl)
        sands.append({'phi': phi, 'vsh': vsh, 'peffMPa': peff, 'fluid': {'k': kfl, 'rho': rhofl}, 'vp': vp, 'vs': vs, 'rho': rho})
    out = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'test-data', 'qi', 'goldens.feasibilitySweep.json')
    with open(out, 'w') as f:
        json.dump({'source': 'tools/validation/qi/oracle_feasibility_sweep.py', 'backus': {'layers': [[0.6, 3200, 1800, 2300], [0.4, 2700, 1200, 2450]], 'out': two}, 'sands': sands}, f)
    print('wrote', len(sands), 'sands')


if __name__ == '__main__':
    main()
