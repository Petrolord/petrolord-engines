"""Independent oracle for engines/rockphysics/granular.js (QI programme Q2).

Written from the published equations, not translated from the JS:
  Mavko, Mukerji & Dvorkin, The Rock Physics Handbook, 2nd ed. (2009):
    4.1  Hashin-Shtrikman-Walpole bounds
    5.4  Hertz-Mindlin; soft-sand (modified lower HS) and stiff-sand
         (modified upper HS) models; Dvorkin-Nur contact cement
  Avseth, Dvorkin, Mavko & Rykkje (2000): constant cement
  Brie et al. (1995): patchy fluid modulus

Standard library only. main() asserts physics anchors (A1..A9) before it
writes test-data/rockphysics/goldens.granular.json, so a broken oracle cannot
produce goldens. Regenerating must be byte-identical.
"""
import json
import math
import os

GPa = 1e9
MPa = 1e6
QUARTZ = dict(K=36.6 * GPa, G=45.0 * GPa)
CLAY = dict(K=21.0 * GPa, G=7.0 * GPa)
BRINE_K = 2.8 * GPa
GAS_K = 0.05 * GPa


def nu_of(K, G):
    return (3 * K - 2 * G) / (2 * (3 * K + G))


def zeta(K, G):
    return G / 6.0 * (9 * K + 8 * G) / (K + 2 * G)


def hs_bounds(phases):
    live = [p for p in phases if p[2] > 0]
    kmax = max(p[0] for p in live)
    kmin = min(p[0] for p in live)
    gmax = max(p[1] for p in live)
    gmin = min(p[1] for p in live)

    def lam(z):
        return 1.0 / sum(f / (k + 4.0 / 3.0 * z) for k, _g, f in live) - 4.0 / 3.0 * z

    def gam(z):
        s = 0.0
        for _k, g, f in live:
            if g + z == 0:
                return 0.0
            s += f / (g + z)
        return 1.0 / s - z

    return dict(kUpper=lam(gmax), kLower=lam(gmin),
                gUpper=gam(zeta(kmax, gmax)), gLower=gam(zeta(kmin, gmin)) if gmin > 0 else 0.0)


def hertz_mindlin(K, G, phiC, n, P, f=1.0):
    nu = nu_of(K, G)
    a = n * n * (1 - phiC) ** 2 * G * G * P / (math.pi ** 2 * (1 - nu) ** 2)
    khm = (a / 18.0) ** (1.0 / 3.0)
    ghm = (2 + 3 * f - nu * (1 + 3 * f)) / (5 * (2 - nu)) * (1.5 * a) ** (1.0 / 3.0)
    return khm, ghm


def mod_hs(phi, phi_end, k_end, g_end, K, G, lower):
    """Modified HS line between an end member at phi_end and the mineral."""
    x = phi / phi_end
    kz = g_end if lower else G            # the shear modulus inside 4/3 z for K
    kd = 1.0 / (x / (k_end + 4.0 / 3.0 * kz) + (1 - x) / (K + 4.0 / 3.0 * kz)) - 4.0 / 3.0 * kz
    z = zeta(k_end, g_end) if lower else zeta(K, G)
    gd = 1.0 / (x / (g_end + z) + (1 - x) / (G + z)) - z
    return kd, gd


def soft_sand(K, G, phi, phiC, n, P, f=1.0):
    khm, ghm = hertz_mindlin(K, G, phiC, n, P, f)
    return mod_hs(phi, phiC, khm, ghm, K, G, lower=True)


def stiff_sand(K, G, phi, phiC, n, P, f=1.0):
    khm, ghm = hertz_mindlin(K, G, phiC, n, P, f)
    return mod_hs(phi, phiC, khm, ghm, K, G, lower=False)


def contact_cement(K, G, Kc, Gc, phi, phi0, n, scheme):
    nu = nu_of(K, G)
    nuc = nu_of(Kc, Gc)
    if scheme == 'contact':
        alpha = 2.0 * ((phi0 - phi) / (3.0 * n * (1 - phi0))) ** 0.25
    else:
        alpha = math.sqrt(2.0 * (phi0 - phi) / (3.0 * (1 - phi0)))
    ln = 2 * Gc * (1 - nu) * (1 - nuc) / (math.pi * G * (1 - 2 * nuc))
    lt = Gc / (math.pi * G)
    an, bn, cn = -0.024153 * ln ** -1.3646, 0.20405 * ln ** -0.89008, 0.00024649 * ln ** -1.9864
    at = -1e-2 * (2.26 * nu ** 2 + 2.07 * nu + 2.3) * lt ** (0.079 * nu ** 2 + 0.1754 * nu - 1.342)
    bt = (0.0573 * nu ** 2 + 0.0937 * nu + 0.202) * lt ** (0.0274 * nu ** 2 + 0.0529 * nu - 0.8765)
    ct = 1e-4 * (9.654 * nu ** 2 + 4.945 * nu + 3.1) * lt ** (0.01867 * nu ** 2 + 0.4011 * nu - 1.8186)
    sn = an * alpha ** 2 + bn * alpha + cn
    st = at * alpha ** 2 + bt * alpha + ct
    kd = n * (1 - phi0) * (Kc + 4.0 / 3.0 * Gc) * sn / 6.0
    gd = 0.6 * kd + 0.15 * n * (1 - phi0) * Gc * st
    return kd, gd


def constant_cement(K, G, Kc, Gc, phi, phiB, phi0, n, scheme):
    kb, gb = contact_cement(K, G, Kc, Gc, phiB, phi0, n, scheme)
    return mod_hs(phi, phiB, kb, gb, K, G, lower=True)


def brie(kl, kg, sw, e):
    return (kl - kg) * sw ** e + kg


def close(a, b, rel=1e-9):
    return abs(a - b) <= rel * max(abs(a), abs(b), 1e-30)


def anchors():
    K, G = QUARTZ['K'], QUARTZ['G']
    # A1 HS bounds of one phase are the phase itself
    b = hs_bounds([(K, G, 1.0)])
    assert close(b['kUpper'], K) and close(b['kLower'], K) and close(b['gUpper'], G), 'A1'
    # A2 HS bounds bracket each other and sit inside Voigt-Reuss
    ph = [(K, G, 0.7), (CLAY['K'], CLAY['G'], 0.3)]
    b = hs_bounds(ph)
    kv = sum(k * f for k, _g, f in ph)
    kr = 1.0 / sum(f / k for k, _g, f in ph)
    assert kr <= b['kLower'] <= b['kUpper'] <= kv, 'A2'
    # A3 a fluid phase sends the lower shear bound to zero
    assert hs_bounds([(K, G, 0.8), (BRINE_K, 0.0, 0.2)])['gLower'] == 0.0, 'A3'
    # A4 soft and stiff sand equal Hertz-Mindlin at critical porosity
    khm, ghm = hertz_mindlin(K, G, 0.36, 9, 20 * MPa)
    for fn in (soft_sand, stiff_sand):
        kd, gd = fn(K, G, 0.36, 0.36, 9, 20 * MPa)
        assert close(kd, khm) and close(gd, ghm), 'A4'
    # A5 both reach the mineral at zero porosity
    for fn in (soft_sand, stiff_sand):
        kd, gd = fn(K, G, 0.0, 0.36, 9, 20 * MPa)
        assert close(kd, K) and close(gd, G), 'A5'
    # A6 stiff sand is stiffer than soft sand between the end points
    s, t = soft_sand(K, G, 0.2, 0.36, 9, 20 * MPa), stiff_sand(K, G, 0.2, 0.36, 9, 20 * MPa)
    assert t[0] > s[0] and t[1] > s[1], 'A6'
    # A7 Hertz-Mindlin scales as pressure^(1/3)
    k1, _ = hertz_mindlin(K, G, 0.36, 9, 10 * MPa)
    k8, _ = hertz_mindlin(K, G, 0.36, 9, 80 * MPa)
    assert close(k8 / k1, 2.0), 'A7'
    # A8 Brie: e=1 is the Voigt mix; large e tends to the gas modulus at Sw<1
    assert close(brie(BRINE_K, GAS_K, 0.4, 1), 0.4 * BRINE_K + 0.6 * GAS_K), 'A8'
    # A9 contact cement stiffens with more cement (lower porosity)
    c1 = contact_cement(K, G, K, G, 0.35, 0.36, 9, 'surface')
    c2 = contact_cement(K, G, K, G, 0.30, 0.36, 9, 'surface')
    assert c2[0] > c1[0] and c2[1] > c1[1], 'A9'


def goldens():
    K, G = QUARTZ['K'], QUARTZ['G']
    out = {'hertzMindlin': [], 'softSand': [], 'stiffSand': [], 'contactCement': [], 'constantCement': [], 'hs': [], 'brie': []}
    for P in (5 * MPa, 20 * MPa, 40 * MPa):
        for n in (6, 9, 12):
            for f in (1.0, 0.5):
                khm, ghm = hertz_mindlin(K, G, 0.36, n, P, f)
                out['hertzMindlin'].append(dict(K=K, G=G, phiC=0.36, n=n, P=P, f=f, k=khm, g=ghm))
    for phi in (0.0, 0.05, 0.12, 0.2, 0.3, 0.36):
        for fn, key in ((soft_sand, 'softSand'), (stiff_sand, 'stiffSand')):
            kd, gd = fn(K, G, phi, 0.36, 9, 20 * MPa)
            out[key].append(dict(K=K, G=G, phi=phi, phiC=0.36, n=9, P=20 * MPa, k=kd, g=gd))
    for scheme in ('surface', 'contact'):
        for phi in (0.36, 0.34, 0.30, 0.25, 0.20):
            kd, gd = contact_cement(K, G, K, G, phi, 0.36, 9, scheme)
            out['contactCement'].append(dict(K=K, G=G, Kc=K, Gc=G, phi=phi, phi0=0.36, n=9, scheme=scheme, k=kd, g=gd))
    for phi in (0.0, 0.1, 0.2, 0.33):
        kd, gd = constant_cement(K, G, K, G, phi, 0.33, 0.36, 9, 'surface')
        out['constantCement'].append(dict(K=K, G=G, Kc=K, Gc=G, phi=phi, phiB=0.33, phi0=0.36, n=9, scheme='surface', k=kd, g=gd))
    for fq in (0.0, 0.3, 0.7, 1.0):
        phases = [(K, G, fq), (CLAY['K'], CLAY['G'], 1 - fq)]
        b = hs_bounds(phases)
        out['hs'].append(dict(phases=[dict(K=k, G=g, f=f) for k, g, f in phases], **b))
    b = hs_bounds([(K, G, 0.75), (BRINE_K, 0.0, 0.25)])
    out['hs'].append(dict(phases=[dict(K=K, G=G, f=0.75), dict(K=BRINE_K, G=0.0, f=0.25)], **b))
    for sw in (0.0, 0.1, 0.5, 0.9, 1.0):
        for e in (1, 3, 10):
            out['brie'].append(dict(kLiquid=BRINE_K, kGas=GAS_K, sw=sw, e=e, k=brie(BRINE_K, GAS_K, sw, e)))
    return out


def main():
    anchors()
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', '..', '..', 'test-data', 'rockphysics', 'goldens.granular.json')
    with open(dest, 'w') as fh:
        json.dump(goldens(), fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors A1-A9 ok; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
