"""Independent oracle for engines/qi/avo.js (NextGen QI extraction gate, E1b, gap G3).

Nothing here restates the engine's closed forms. Each quantity comes by a
different route:

- Reflectivity: the EXACT Zoeppritz equations, written as the 4x4 scattering
  system of Aki and Richards (1980, eq. 5.40; the matrix form given e.g. by
  Castagna 1993) and solved by complex Gaussian elimination with partial
  pivoting. It is cross-checked against the rockphysics oracle's Zoeppritz
  (Dvorkin et al. 2014 closed form, test-data/rockphysics/goldens.json) on the
  four classic Rutherford-Williams / Castagna cases.
- The linearised (Aki-Richards) reflectivity is obtained as the DERIVATIVE of
  the exact Zoeppritz reflectivity with respect to the contrast size eps at
  eps = 0: two layers mean * (1 -/+ eps c / 2), so Delta/mean = eps c exactly
  and the mean Vs/Vp is fixed; central differences at eps = 1e-3 and 5e-4,
  Richardson-extrapolated (error O(eps^4)).
- Shuey's A, B and C are read off that linear curve: A = L(0); B is the
  derivative of L in sin^2(theta) at zero (Richardson again); C from
  L(30 deg) - A - B sin^2 over tan^2 - sin^2.
- fitShuey: weighted least squares by Householder QR on sqrt(w)-scaled rows
  (the engine forms normal equations and eliminates).
- contrastsFromAB: the 3x3 linear system (Shuey A, Shuey B, Gardner
  drho/rho = dVp/Vp / 4) solved numerically by Gaussian elimination in exact
  rationals; the Smith-Gidlow fluid factor dVp/Vp - 1.16 (Vs/Vp) dVs/Vs.
- backgroundTrend: the slope of the principal eigenvector of the uncentred
  2x2 scatter matrix from the quadratic formula (the engine uses the
  half-angle atan2), confirmed by a golden-section minimisation of the
  summed squared perpendicular distance over the line's angle.
- offTrend: the foot of the perpendicular from (A, B) onto the line, its
  length signed negative below the line.
- chiProjection: the dot product with the unit vector at chi.
- avoClass: Rutherford and Williams (1989) I to III with Castagna's IV, at
  the QI convention (I for A >= band, IV for B >= 0 when A <= -band).

Standard library only; main() asserts its anchors, refuses an empty case
list, and writes test-data/qi/goldens.qiAvo.json (byte-identical on rerun).
"""
import cmath
import json
import math
import os
import sys
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
ANGLES = [0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0]


def nonempty(name, xs):
    if not xs:
        sys.exit('REFUSED: empty case list ' + name)
    return xs


# --------------------------------------------------------------------------
# exact Zoeppritz, 4x4 scattering matrix, complex Gaussian elimination

def csolve(M, v):
    n = len(v)
    a = [list(M[i]) + [v[i]] for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(a[r][c]))
        if abs(a[p][c]) < 1e-300:
            raise ValueError('singular')
        a[c], a[p] = a[p], a[c]
        for r in range(c + 1, n):
            f = a[r][c] / a[c][c]
            for k in range(c, n + 1):
                a[r][k] -= f * a[c][k]
    x = [0j] * n
    for i in range(n - 1, -1, -1):
        s = a[i][n]
        for j in range(i + 1, n):
            s -= a[i][j] * x[j]
        x[i] = s / a[i][i]
    return x


def zoeppritz(a1, b1, r1, a2, b2, r2, theta_deg):
    """Exact P-P reflection coefficient (complex beyond a critical angle)."""
    t1 = math.radians(theta_deg)
    p = math.sin(t1) / a1
    s_t1, c_t1 = complex(math.sin(t1)), complex(math.cos(t1))
    s_t2 = p * a2
    s_f1 = p * b1
    s_f2 = p * b2

    def cos_of(s):
        c = cmath.sqrt(1 - s * s)
        return c if c.imag >= 0 else -c
    c_t2, c_f1, c_f2 = cos_of(s_t2), cos_of(s_f1), cos_of(s_f2)
    # displacement and traction continuity (Aki and Richards 5.40, rows
    # scaled the usual way)
    M = [
        [-s_t1, -c_f1, s_t2, c_f2],
        [c_t1, -s_f1, c_t2, -s_f2],
        [2 * r1 * b1 * s_f1 * c_t1, r1 * b1 * (1 - 2 * s_f1 ** 2), 2 * r2 * b2 * s_f2 * c_t2, r2 * b2 * (1 - 2 * s_f2 ** 2)],
        [-r1 * a1 * (1 - 2 * s_f1 ** 2), r1 * b1 * 2 * s_f1 * c_f1, r2 * a2 * (1 - 2 * s_f2 ** 2), -r2 * b2 * 2 * s_f2 * c_f2],
    ]
    N = [s_t1, c_t1, 2 * r1 * b1 * s_f1 * c_t1, r1 * a1 * (1 - 2 * s_f1 ** 2)]
    return csolve(M, N)[0]


def zre(*args):
    return zoeppritz(*args).real


# --------------------------------------------------------------------------
# the linear term as d R / d eps at eps = 0

def layers(mean, c, eps):
    vp, vs, rho = mean
    return (vp * (1 - eps * c['dVpVp'] / 2), vs * (1 - eps * c['dVsVs'] / 2), rho * (1 - eps * c['dRhoRho'] / 2),
            vp * (1 + eps * c['dVpVp'] / 2), vs * (1 + eps * c['dVsVs'] / 2), rho * (1 + eps * c['dRhoRho'] / 2))


def linear_term(mean, c, theta):
    def d(e):
        return (zre(*layers(mean, c, e), theta) - zre(*layers(mean, c, -e), theta)) / (2 * e)
    h = 1e-3
    return (4 * d(h / 2) - d(h)) / 3


def shuey_from_linear(mean, c):
    A = linear_term(mean, c, 0.0)

    def slope(s2):
        th = math.degrees(math.asin(math.sqrt(s2)))
        return (linear_term(mean, c, th) - A) / s2
    # slope(s2) = B + O(s2): two Richardson levels remove the s2 and s2^2 terms
    h = 4e-3
    r1 = [2 * slope(x / 2) - slope(x) for x in (h, h / 2)]
    B = (4 * r1[1] - r1[0]) / 3
    th = 30.0
    s2 = math.sin(math.radians(th)) ** 2
    C = (linear_term(mean, c, th) - A - B * s2) / (math.tan(math.radians(th)) ** 2 - s2)
    return A, B, C


# --------------------------------------------------------------------------
# Householder QR least squares

def householder_lstsq(X, y):
    m, k = len(X), len(X[0])
    R = [list(r) for r in X]
    q = list(y)
    for j in range(k):
        norm = math.sqrt(sum(R[i][j] ** 2 for i in range(j, m)))
        if norm == 0:
            return None
        alpha = -norm if R[j][j] >= 0 else norm
        v = [0.0] * m
        v[j] = R[j][j] - alpha
        for i in range(j + 1, m):
            v[i] = R[i][j]
        vv = sum(x * x for x in v)
        if vv == 0:
            continue
        for col in range(j, k):
            s = sum(v[i] * R[i][col] for i in range(j, m))
            for i in range(j, m):
                R[i][col] -= 2 * s / vv * v[i]
        s = sum(v[i] * q[i] for i in range(j, m))
        for i in range(j, m):
            q[i] -= 2 * s / vv * v[i]
    x = [0.0] * k
    for i in range(k - 1, -1, -1):
        x[i] = (q[i] - sum(R[i][j] * x[j] for j in range(i + 1, k))) / R[i][i]
    return x


def lcg(seed):
    s = seed
    while True:
        s = (1103515245 * s + 12345) % 2147483648
        yield s / 2147483648 - 0.5


def fit_case(name, angles, amps, terms, weights):
    rows, ys, n = [], [], 0
    for i, th in enumerate(angles):
        y = amps[i]
        if y is None or not math.isfinite(y):
            continue
        w = 1.0 if weights is None else weights[i]
        if not w > 0:
            continue
        t = math.radians(th)
        s2 = math.sin(t) ** 2
        basis = [1.0, s2] + ([math.tan(t) ** 2 - s2] if terms == 3 else [])
        sw = math.sqrt(w)
        rows.append([sw * b for b in basis])
        ys.append(sw * y)
        n += 1
    x = householder_lstsq(rows, ys)
    return dict(name=name, angles=angles, amps=amps, terms=terms, weights=weights,
                A=x[0], B=x[1], C=x[2] if terms == 3 else 0.0, n=n)


# --------------------------------------------------------------------------
# contrasts from A and B: exact rational elimination

def contrasts_case(A, B, vsVp):
    g2 = Fraction(vsVp) ** 2
    h = Fraction(1, 2)
    # unknowns dVp, dVs, drho
    M = [[h, Fraction(0), h], [h, -4 * g2, -2 * g2], [-Fraction(1, 4), Fraction(0), Fraction(1)]]
    v = [Fraction(A), Fraction(B), Fraction(0)]
    n = 3
    a = [M[i] + [v[i]] for i in range(n)]
    for c in range(n):
        p = next(r for r in range(c, n) if a[r][c] != 0)
        a[c], a[p] = a[p], a[c]
        for r in range(n):
            if r != c and a[r][c] != 0:
                f = a[r][c] / a[c][c]
                a[r] = [a[r][k] - f * a[c][k] for k in range(n + 1)]
    dvp, dvs, drho = (a[i][n] / a[i][i] for i in range(n))
    ff = dvp - Fraction(116, 100) * Fraction(vsVp) * dvs
    return dict(A=A, B=B, vsVp=vsVp, dVpVp=float(dvp), dVsVs=float(dvs), dRhoRho=float(drho), fluidFactor=float(ff))


# --------------------------------------------------------------------------
# background trend

def trend_case(name, As, Bs):
    pts = [(a, b) for a, b in zip(As, Bs) if a is not None and b is not None and math.isfinite(a) and math.isfinite(b)]
    if len(pts) < 3:
        return dict(name=name, As=As, Bs=Bs, m=None, n=len(pts), olsSlope=None)  # too few points: no trend
    saa = sum(a * a for a, _ in pts)
    sbb = sum(b * b for _, b in pts)
    sab = sum(a * b for a, b in pts)
    lam = (saa + sbb) / 2 + math.sqrt(((saa - sbb) / 2) ** 2 + sab * sab)
    m = (lam - saa) / sab

    def cost(phi):
        c, s = math.cos(phi), math.sin(phi)
        return sum((b * c - a * s) ** 2 for a, b in pts)
    lo, hi = math.atan(m) - 0.3, math.atan(m) + 0.3
    g = (math.sqrt(5) - 1) / 2
    for _ in range(200):
        x1, x2 = hi - g * (hi - lo), lo + g * (hi - lo)
        if cost(x1) < cost(x2):
            hi = x2
        else:
            lo = x1
    m_gs = math.tan((lo + hi) / 2)
    assert abs(m_gs - m) < 1e-7 * max(1, abs(m)), (name, m, m_gs)
    ols = sab / saa
    return dict(name=name, As=As, Bs=Bs, m=m, n=len(pts), olsSlope=ols)


def off_trend(A, B, m):
    # foot of the perpendicular from P onto the line through the origin with direction u
    ux, uy = 1 / math.sqrt(1 + m * m), m / math.sqrt(1 + m * m)
    t = A * ux + B * uy
    fx, fy = t * ux, t * uy
    d = math.hypot(A - fx, B - fy)
    return -d if B < m * A else d


def avo_class(A, B, band=0.02):
    # The shared convention (owner decision 2026-10-12, engines/rockphysics/avo.js):
    # class II is the closed band |A| <= band, class IV needs B strictly positive.
    if not (math.isfinite(A) and math.isfinite(B)):
        return None
    if A > band:
        return 'I'
    if -band <= A <= band:
        return 'II'
    return 'IV' if B > 0 else 'III'


def main():
    rp = json.load(open(os.path.join(ROOT, 'test-data', 'rockphysics', 'goldens.json')))
    classic = nonempty('classic', rp['avo'])

    # anchor 1: this exact Zoeppritz equals the rockphysics oracle's closed form
    for case in classic:
        u, lw = case['upper'], case['lower']
        for pt in case['curve']:
            z = zoeppritz(u['vp'], u['vs'], u['rho'], lw['vp'], lw['vs'], lw['rho'], pt['theta'])
            assert abs(z.real - pt['zoeppritz_re']) < 1e-12 and abs(z.imag - pt['zoeppritz_im']) < 1e-12, (case['name'], pt['theta'], z)
    # anchor 2: normal incidence is (I2 - I1) / (I2 + I1)
    z0 = zre(2500, 1200, 2300, 3000, 1500, 2400, 0.0)
    assert abs(z0 - (3000 * 2400 - 2500 * 2300) / (3000 * 2400 + 2500 * 2300)) < 1e-14

    # classic cases: contrasts by definition, and the bruges-checked A, B, C beside them
    classics = []
    for case in classic:
        u, lw = case['upper'], case['lower']
        vp, vs, rho = (u['vp'] + lw['vp']) / 2, (u['vs'] + lw['vs']) / 2, (u['rho'] + lw['rho']) / 2
        c = dict(dVpVp=(lw['vp'] - u['vp']) / vp, dVsVs=(lw['vs'] - u['vs']) / vs, dRhoRho=(lw['rho'] - u['rho']) / rho, vsVp=vs / vp)
        classics.append(dict(name=case['name'], contrasts=c, A=case['A'], B=case['B'], C=case['C'],
                             avoClass=avo_class(case['A'], case['B']), expect=case['expect']))
        assert avo_class(case['A'], case['B']) == case['expect']

    # weak-contrast linear term and Shuey terms from the exact equations
    MEAN = (3000.0, 1500.0, 2300.0)
    weak_specs = nonempty('weak', [
        ('brine', dict(dVpVp=0.10, dVsVs=0.14, dRhoRho=0.025)),
        ('gas', dict(dVpVp=-0.12, dVsVs=0.05, dRhoRho=-0.03)),
        ('soft_shale', dict(dVpVp=-0.06, dVsVs=-0.09, dRhoRho=0.04)),
        ('hard_carbonate', dict(dVpVp=0.30, dVsVs=0.22, dRhoRho=0.08)),
    ])
    weak = []
    for name, c in weak_specs:
        lin = [linear_term(MEAN, c, th) for th in ANGLES]
        A, B, C = shuey_from_linear(MEAN, c)
        # anchor 3: the linear term is the small-contrast limit (residual shrinks as eps^2)
        e1, e2 = 0.02, 0.01
        r1 = abs(zre(*layers(MEAN, c, e1), 25.0) / e1 - lin[5])
        r2 = abs(zre(*layers(MEAN, c, e2), 25.0) / e2 - lin[5])
        assert 1.5 < r1 / r2 < 2.5 or r1 < 1e-9, (name, r1, r2)  # O(eps) in R/eps, i.e. O(eps^2) in R
        # anchor 4: A + B s2 + C(tan2 - s2) rebuilds the linear curve at every angle (the Shuey form is exact for the linear term)
        for th, L in zip(ANGLES, lin):
            t = math.radians(th)
            assert abs(A + B * math.sin(t) ** 2 + C * (math.tan(t) ** 2 - math.sin(t) ** 2) - L) < 1e-8, (name, th)
        weak.append(dict(name=name, contrasts=dict(c, vsVp=MEAN[1] / MEAN[0]), angles=ANGLES, linear=lin, A=A, B=B, C=C))

    # least-squares fits on noisy exact-Zoeppritz amplitudes
    u, lw = classic[2]['upper'], classic[2]['lower']
    exact = [zre(u['vp'], u['vs'], u['rho'], lw['vp'], lw['vs'], lw['rho'], th) for th in ANGLES]
    noise = lcg(20261011)
    noisy = [z + 0.004 * next(noise) for z in exact]
    w = [1.0, 2.0, 0.5, 1.5, 1.0, 3.0, 0.25, 1.0, 2.0]
    gapped = list(noisy)
    gapped[3] = None
    fits = nonempty('fits', [
        fit_case('two_term_all', ANGLES, noisy, 2, None),
        fit_case('three_term_all', ANGLES, noisy, 3, None),
        fit_case('two_term_near', ANGLES[:6], noisy[:6], 2, None),
        fit_case('two_term_weighted', ANGLES, noisy, 2, w),
        fit_case('three_term_weighted_gap', ANGLES, gapped, 3, w),
        fit_case('three_term_exact', ANGLES, exact, 3, None),
    ])
    # anchor 5: the QR solution satisfies the normal equations
    for f in fits:
        pts = [(th, y, 1.0 if f['weights'] is None else f['weights'][i]) for i, (th, y) in enumerate(zip(f['angles'], f['amps'])) if y is not None]
        for j in range(f['terms']):
            g = 0.0
            for th, y, wt in pts:
                t = math.radians(th)
                s2 = math.sin(t) ** 2
                basis = [1.0, s2, math.tan(t) ** 2 - s2][:f['terms']]
                pred = f['A'] * basis[0] + f['B'] * basis[1] + (f['C'] * basis[2] if f['terms'] == 3 else 0)
                g += wt * basis[j] * (y - pred)
            assert abs(g) < 1e-12, (f['name'], j, g)

    # contrasts from A and B
    cons = nonempty('contrasts', [contrasts_case(c['A'], c['B'], c['contrasts']['vsVp']) for c in classics]
                    + [contrasts_case(x['A'], x['B'], 0.5) for x in weak]
                    + [contrasts_case(0.0624, -0.1424, 0.5)])
    # anchor 6: Gardner holds and A is rebuilt; on Castagna's mudrock line the fluid factor is zero
    for k in cons:
        assert abs(k['dRhoRho'] - k['dVpVp'] / 4) < 1e-15
        assert abs(0.5 * (k['dVpVp'] + k['dRhoRho']) - k['A']) < 1e-15
    mud = contrasts_case(0.5 * (0.0928 + 0.0232), 0.5 * 0.0928 - 4 * 0.25 * 0.16 - 2 * 0.25 * 0.0232, 0.5)
    assert abs(mud['fluidFactor']) < 1e-12

    # background trends
    noise = lcg(7)
    As1 = [-0.12 + 0.005 * i for i in range(48)]
    Bs1 = [-1.4 * a + 0.01 * next(noise) for a in As1]
    As2 = [0.03 * next(noise) * 4 for _ in range(60)]
    Bs2 = [-0.8 * a + 0.03 * next(noise) for a in As2]
    As3 = list(As2[:30]) + [None, 0.05]
    Bs3 = list(Bs2[:30]) + [0.1, None]
    trends = nonempty('trends', [trend_case('tight_minus_1p4', As1, Bs1), trend_case('loose_minus_0p8', As2, Bs2),
                                 trend_case('with_gaps', As3, Bs3), trend_case('two_points', [0.1, -0.1, None], [-0.2, 0.15, 0.3])])
    assert trends[3]['m'] is None and trends[3]['n'] == 2
    for t in trends[:3]:
        assert abs(t['m'] - t['olsSlope']) > 1e-4, t['name']  # orthogonal and OLS slopes differ on these clouds
    m0 = trends[0]['m']
    offs = nonempty('off', [dict(A=a, B=b, m=m0, d=off_trend(a, b, m0)) for a, b in
                            [(0.1, -0.3), (-0.1, -0.3), (0.05, 0.02), (-0.08, 0.2), (0.0, 0.0), (0.12, -0.17)]])
    # anchor 7: the distance is the perpendicular one (the foot plus d * normal returns the point)
    for o in offs:
        nx, ny = -o['m'] / math.sqrt(1 + o['m'] ** 2), 1 / math.sqrt(1 + o['m'] ** 2)
        t = (o['A'] + o['B'] * o['m']) / math.sqrt(1 + o['m'] ** 2)
        fx, fy = t / math.sqrt(1 + o['m'] ** 2), t * o['m'] / math.sqrt(1 + o['m'] ** 2)
        assert abs(fx + o['d'] * nx - o['A']) < 1e-14 and abs(fy + o['d'] * ny - o['B']) < 1e-14
    chis = nonempty('chi', [dict(A=a, B=b, chi=chi, value=sum(p * q for p, q in zip((a, b), (math.cos(math.radians(chi)), math.sin(math.radians(chi)))))) for a, b, chi in
                            [(0.1, -0.2, 0.0), (0.1, -0.2, 90.0), (0.14, -0.39, 20.0), (-0.11, -0.24, -35.0), (0.03, 0.05, 63.4)]])
    classes = nonempty('classes', [dict(A=a, B=b, avoClass=avo_class(a, b)) for a, b in
                                   [(0.05, -0.1), (0.0, -0.1), (-0.08, -0.1), (-0.08, 0.02), (0.02, -0.3), (-0.02, -0.3), (-0.02, 0.3),
                                    (0.019999, 0.1), (-0.0200001, 0.0), (0.1440, -0.5151), (0.0200001, -0.3), (-0.0200001, -1e-12),
                                    (-0.0200001, 1e-12), (-0.05, 0.0), (0.0, 0.0)]])
    assert [c['avoClass'] for c in classes] == ['I', 'II', 'III', 'IV', 'II', 'II', 'II', 'II', 'III', 'I', 'I', 'III', 'IV', 'III', 'II']
    g = dict(classics=classics, weak=weak, fits=fits, contrasts=cons, trends=trends, offTrend=offs, chi=chis, classes=classes)
    dest = os.path.join(ROOT, 'test-data', 'qi', 'goldens.qiAvo.json')
    if len(sys.argv) > 1:
        dest = sys.argv[1]
    with open(dest, 'w') as fh:
        json.dump(g, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors ok; classics', len(classics), 'weak', len(weak), 'fits', len(fits), 'trends', len(trends), '; wrote', dest)


if __name__ == '__main__':
    main()
