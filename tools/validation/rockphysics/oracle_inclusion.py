"""Independent oracle for engines/rockphysics/inclusion.js (QI programme Q2, A1b).

From the published equations: Mavko, Mukerji & Dvorkin, The Rock Physics
Handbook, 2nd ed. (2009), 4.8 (Berryman 1980 P and Q; Kuster-Toksoz) and
4.11 (differential effective medium); Xu & White (1995). Standard library
only. The DEM ODE is integrated with classical RK4 at 20,000 steps (the
engine uses 400 by default; the gate allows 1e-7 relative).

main() asserts anchors B1..B7 before writing goldens.inclusion.json.
"""
import json
import math
import os

GPa = 1e9


def zeta(K, G):
    return G / 6.0 * (9 * K + 8 * G) / (K + 2 * G)


def pq(Km, Gm, Ki, Gi, a):
    if abs(a - 1) < 1e-6:
        return (Km + 4 * Gm / 3) / (Ki + 4 * Gm / 3), (Gm + zeta(Km, Gm)) / (Gi + zeta(Km, Gm))
    if a < 1:
        th = a / (1 - a * a) ** 1.5 * (math.acos(a) - a * math.sqrt(1 - a * a))
    else:
        th = a / (a * a - 1) ** 1.5 * (a * math.sqrt(a * a - 1) - math.acosh(a))
    f = a * a * (3 * th - 2) / (1 - a * a)
    A = Gi / Gm - 1
    B = (Ki / Km - Gi / Gm) / 3
    R = Gm / (Km + 4 * Gm / 3)
    F1 = 1 + A * (1.5 * (f + th) - R * (1.5 * f + 2.5 * th - 4 / 3))
    F2 = (1 + A * (1 + 1.5 * (f + th) - R * (1.5 * f + 2.5 * th)) + B * (3 - 4 * R)
          + A * (A + 3 * B) * (1.5 - 2 * R) * (f + th - R * (f - th + 2 * th * th)))
    F3 = 1 + A * (1 - f - 1.5 * th + R * (f + th))
    F4 = 1 + A / 4 * (f + 3 * th - R * (f - th))
    F5 = A * (-f + R * (f + th - 4 / 3)) + B * th * (3 - 4 * R)
    F6 = 1 + A * (1 + f - R * (f + th)) + B * (1 - th) * (3 - 4 * R)
    F7 = 2 + A / 4 * (3 * f + 9 * th - R * (3 * f + 5 * th)) + B * th * (3 - 4 * R)
    F8 = A * (1 - 2 * R + f / 2 * (R - 1) + th / 2 * (5 * R - 3)) + B * (1 - th) * (3 - 4 * R)
    F9 = A * ((R - 1) * f - R * th) + B * th * (3 - 4 * R)
    t1 = 3 * F1 / F2
    t2 = t1 / 3 + 2 / F3 + 1 / F4 + (F4 * F5 + F6 * F7 - F8 * F9) / (F2 * F4)
    return t1 / 3, (t2 - t1 / 3) / 5


def kt(Km, Gm, inc):
    sk = sum(x * (Ki - Km) * pq(Km, Gm, Ki, Gi, a)[0] for Ki, Gi, a, x in inc)
    sg = sum(x * (Gi - Gm) * pq(Km, Gm, Ki, Gi, a)[1] for Ki, Gi, a, x in inc)
    c, z = 4 * Gm / 3, zeta(Km, Gm)
    return (Km * (Km + c) + sk * c) / (Km + c - sk), (Gm * (Gm + z) + sg * z) / (Gm + z - sg)


def dem(Km, Gm, inc, y, n=20000):
    def rate(t, K, G):
        dk = dg = 0.0
        for Ki, Gi, a, w in inc:
            P, Q = pq(K, G, Ki, Gi, a)
            dk += w * (Ki - K) * P
            dg += w * (Gi - G) * Q
        return dk / (1 - t), dg / (1 - t)
    K, G, h = Km, Gm, y / n
    for i in range(n):
        t = i * h
        a1 = rate(t, K, G)
        a2 = rate(t + h / 2, K + h / 2 * a1[0], G + h / 2 * a1[1])
        a3 = rate(t + h / 2, K + h / 2 * a2[0], G + h / 2 * a2[1])
        a4 = rate(t + h, K + h * a3[0], G + h * a3[1])
        K += h / 6 * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0])
        G += h / 6 * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1])
    return K, G


def hs_avg2(K1, G1, K2, G2, f2):
    ph = [(K1, G1, 1 - f2), (K2, G2, f2)]
    ph = [p for p in ph if p[2] > 0]
    def lam(z):
        return 1 / sum(f / (k + 4 * z / 3) for k, _g, f in ph) - 4 * z / 3
    def gam(z):
        return 1 / sum(f / (g + z) for _k, g, f in ph) - z
    kmax, gmax = max(p[0] for p in ph), max(p[1] for p in ph)
    kmin, gmin = min(p[0] for p in ph), min(p[1] for p in ph)
    return (lam(gmax) + lam(gmin)) / 2, (gam(zeta(kmax, gmax)) + gam(zeta(kmin, gmin))) / 2


def xu_white(phi, vclay, sand, clay, a_s=0.12, a_c=0.03):
    fc = vclay / (1 - phi)
    Km, Gm = hs_avg2(sand[0], sand[1], clay[0], clay[1], fc)
    kd, gd = dem(Km, Gm, [(0, 0, a_s, 1 - fc), (0, 0, a_c, fc)], phi)
    return Km, Gm, kd, gd


def close(a, b, rel):
    return abs(a - b) <= rel * max(abs(a), abs(b))


QZ = (36.6 * GPa, 45.0 * GPa)
CL = (21.0 * GPa, 7.0 * GPa)


def anchors():
    # B1 the spheroid P, Q tend to the sphere forms as alpha -> 1 from both sides
    s = pq(*QZ, 0, 0, 1.0)
    for a in (0.9999, 1.0001):
        p = pq(*QZ, 0, 0, a)
        assert close(p[0], s[0], 1e-3) and close(p[1], s[1], 1e-3), 'B1'
    # B2 DEM dry spheres in a nu = 0.2 host: K = Km (1-y)^2, G = Gm (1-y)^2
    Km, Gm = 40 * GPa, 30 * GPa
    k, g = dem(Km, Gm, [(0, 0, 1.0, 1.0)], 0.3)
    assert close(k, Km * 0.49, 1e-9) and close(g, Gm * 0.49, 1e-9), 'B2'
    # B3 Kuster-Toksoz with dry spheres is the Hashin-Shtrikman upper bound
    k, g = kt(*QZ, [(0, 0, 1.0, 0.2)])
    a = 4 * QZ[1] / 3
    hs_k = 1 / (0.8 / (QZ[0] + a) + 0.2 / a) - a
    z = zeta(*QZ)
    hs_g = 1 / (0.8 / (QZ[1] + z) + 0.2 / z) - z
    assert close(k, hs_k, 1e-12) and close(g, hs_g, 1e-12), 'B3'
    # B4 an inclusion of the host material changes nothing
    k, g = dem(*QZ, [(QZ[0], QZ[1], 0.05, 1.0)], 0.3, n=200)
    assert close(k, QZ[0], 1e-12) and close(g, QZ[1], 1e-12), 'B4'
    # B5 flatter pores are softer at equal porosity
    k1, _ = dem(*QZ, [(0, 0, 0.5, 1.0)], 0.15, n=2000)
    k2, _ = dem(*QZ, [(0, 0, 0.05, 1.0)], 0.15, n=2000)
    assert k2 < k1, 'B5'
    # B6 DEM and Kuster-Toksoz agree to first order at small concentration
    kd, _ = dem(*QZ, [(0, 0, 0.1, 1.0)], 1e-4, n=50)
    kk, _ = kt(*QZ, [(0, 0, 0.1, 1e-4)])
    assert close(QZ[0] - kd, QZ[0] - kk, 1e-3), 'B6'
    # B7 Xu-White with no clay is the single-pore-type DEM of the sand mineral
    _Km, _Gm, kd, gd = xu_white(0.2, 0.0, QZ, CL)
    k, g = dem(*QZ, [(0, 0, 0.12, 1.0)], 0.2)
    assert close(kd, k, 1e-12) and close(gd, g, 1e-12), 'B7'


def goldens():
    out = {'pq': [], 'kt': [], 'dem': [], 'xuWhite': []}
    for Ki, Gi in ((0.0, 0.0), (2.8 * GPa, 0.0), (21 * GPa, 7 * GPa)):
        for a in (0.01, 0.05, 0.12, 0.5, 1.0, 2.0, 5.0):
            P, Q = pq(*QZ, Ki, Gi, a)
            out['pq'].append(dict(Km=QZ[0], Gm=QZ[1], Ki=Ki, Gi=Gi, alpha=a, P=P, Q=Q))
    for a in (0.1, 0.5, 1.0):
        for x in (0.01, 0.05, 0.1):
            K, G = kt(*QZ, [(0, 0, a, x)])
            out['kt'].append(dict(Km=QZ[0], Gm=QZ[1], inclusions=[dict(K=0, G=0, alpha=a, x=x)], K=K, G=G))
    for a in (0.05, 0.12, 1.0):
        for y in (0.05, 0.15, 0.25):
            K, G = dem(*QZ, [(0, 0, a, 1.0)], y)
            out['dem'].append(dict(Km=QZ[0], Gm=QZ[1], inclusions=[dict(K=0, G=0, alpha=a, w=1.0)], y=y, K=K, G=G))
    K, G = dem(*QZ, [(0, 0, 0.12, 0.7), (0, 0, 0.03, 0.3)], 0.2)
    out['dem'].append(dict(Km=QZ[0], Gm=QZ[1], inclusions=[dict(K=0, G=0, alpha=0.12, w=0.7), dict(K=0, G=0, alpha=0.03, w=0.3)], y=0.2, K=K, G=G))
    for phi in (0.1, 0.2, 0.28):
        for vclay in (0.0, 0.1, 0.3):
            Km, Gm, kd, gd = xu_white(phi, vclay, QZ, CL)
            out['xuWhite'].append(dict(phi=phi, vclay=vclay, kmin=Km, gmin=Gm, kdry=kd, gdry=gd))
    return out


def main():
    anchors()
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', '..', '..', 'test-data', 'rockphysics', 'goldens.inclusion.json')
    with open(dest, 'w') as fh:
        json.dump(goldens(), fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors B1-B7 ok; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
