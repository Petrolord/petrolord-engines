#!/usr/bin/env python3
"""Independent oracle for engines/hse/lopa.js (HSE H3).

stdlib only. Never calls the JavaScript. Writes
test-data/hse/goldens/lopa_cases.json.

TWO ROUTES FOR EVERY PFDavg, ONE EXACT ROUTE FOR EVERY LOPA DECISION.

  route A  closed form, EXACT RATIONAL ARITHMETIC (fractions.Fraction built
           from the decimal strings of the inputs). The IEC 61508-6:2010
           Annex B.3.2.2 equations as Lundteigen & Rausand (NTNU, ch. 8)
           and the 61508 Association (Dolan 2024) state them, written from
           those texts and not from the engine: the koon group failure
           frequency lambda_D,G = (product of rates of successive failures)
           x (equivalent down times of the failures before the last), times
           the group down time tGE. Because the arithmetic is exact, a SIL
           boundary decision (is RRF exactly 100?) is decided exactly here,
           with no floating-point snap; the engine's 1e-9 snap has to
           reach the same answer.

  route B  the TIME-DEPENDENT unavailability, averaged numerically. Each
           channel is a set of independent exponential failure processes:
           covered DU failures renewed at every proof test T1, uncovered DU
           failures (PTC < 1) renewed at T2, DD failures as a repairable
           renewal process at its steady state lambda MTTR / (1 + lambda
           MTTR), and a DU failure found at a test staying down for MRT into
           the next interval. Common cause is the beta-factor model: a
           separate component, rate beta lambda, that fails every channel.
           The system fails when at least n-k+1 of n channels are failed
           (binomial) or the common cause component is. U(t) is averaged
           over the renewal period by composite Simpson quadrature on the
           pieces between tests and MRT ends. Nothing here is linearised,
           so route B is how the simplified equations are DERIVED, not a
           restatement of them. It is NOT expected to equal route A: the
           Annex B forms are first-order in lambda T and use equivalent
           down times for DD and MRT, and the golden records the departure.

WHAT EACH ROUTE CHECKS AND WHAT IT CANNOT

  PFD closed form     route A: every coefficient (the /2, /3, /4, the 2 and
                      6 multiplicities, the (1-beta) placement, MTTR vs MRT)
                      route B: the /2 and /3 and multiplicities by
                      INTEGRATION (a dropped /2 is a factor 2 against B);
                      cannot check: the equivalent-down-time convention for
                      DD and MRT, where A and B differ by design
  2oo2 and beta       Annex B has no beta for 2oo2; route B with beta shows
                      the formula conservative by 2/(2-beta)
  LOPA products       route A exact rationals; decisions exact
  SIL bands           exact rational comparison with the decades
  max proof interval  PFD(T1) is a polynomial of degree <= 3 in T1: its
                      exact coefficients by Lagrange interpolation on
                      Fractions, the root by the quadratic formula (degree
                      <= 2) or by bisection on the polynomial (degree 3);
                      the engine bisects the formula itself

PUBLISHED GOLDENS: the worked SIF of the 61508 Association workshop "SIL
Calculations: Practical Guidance in the use of IEC 61508-6:2010" (Ian
Dolan, Sella Controls, 2024; https://61508.org, file
10B-SIL-Calculations-and-use-of-IEC-61508-6.pdf), values printed to three
significant figures. Its failure rates are the slide's (SINTEF PDS data and
vendor certificates as the slide cites them); they are the slide's
examples, not recommendations. Every other rate in this file is
ILLUSTRATIVE and marked so.

NOT REPRODUCED: the CCPS (2001) continuing example (hexane surge tank). No
legitimately accessible copy of the book was available to check its
numbers, so no golden claims to be it; the LOPA goldens are
ORACLE-DERIVED scenarios shaped like it.
"""

import json
import math
import os
from fractions import Fraction as Fr

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'hse', 'goldens', 'lopa_cases.json')


def F(x):
    """Exact rational from the decimal spelling of a number."""
    if isinstance(x, Fr):
        return x
    return Fr(repr(x)) if isinstance(x, float) else Fr(x)


# ------------------------------------------------------------------ bands

def sil_of_pfd(p):
    """Exact: SIL n holds 10^-(n+1) <= p < 10^-n. Returns (sil, state)."""
    p = F(p)
    if p >= Fr(1, 10):
        return None, 'NOT_SIL_RATED'
    if p < Fr(1, 10 ** 5):
        return 4, 'BELOW_SIL4_TABLE_FLOOR'
    for n in (1, 2, 3, 4):
        if Fr(1, 10 ** (n + 1)) <= p < Fr(1, 10 ** n):
            return n, 'SIL'
    raise AssertionError('PFD %s fell through the band table' % p)


def outcome_of_rrf(rrf):
    rrf = F(rrf)
    if rrf <= 1:
        return {'outcome': 'NO_SIF_REQUIRED', 'requiredSil': None, 'requiredSifPfdAvg': None}
    pfd = 1 / rrf
    if rrf <= 10:
        return {'outcome': 'RISK_REDUCTION_BELOW_SIL1', 'requiredSil': None, 'requiredSifPfdAvg': float(pfd)}
    for n in (1, 2, 3):
        if 10 ** n < rrf <= 10 ** (n + 1):
            return {'outcome': 'SIL%d' % n, 'requiredSil': n, 'requiredSifPfdAvg': float(pfd)}
    return {'outcome': 'BEYOND_SIL3_REDESIGN', 'requiredSil': None, 'requiredSifPfdAvg': float(pfd),
            'pfdInSil4Band': rrf <= 10 ** 5}


# ------------------------------------------------------------------ LOPA

def lopa(ief, tmel, enabling=(), modifiers=(), ipls=(), sif=None):
    f = F(ief)
    en = Fr(1)
    for _, p in enabling:
        en *= F(p)
    cm = Fr(1)
    for _, p in modifiers:
        cm *= F(p)
    credited, not_credited = [], []
    ip = Fr(1)
    for ipl in ipls:
        if ipl.get('independent') is True and ipl.get('auditable') is not False:
            credited.append(ipl['name'])
            ip *= F(ipl['pfd'])
        else:
            not_credited.append(ipl['name'])
    unmit = f * en * cm
    without = unmit * ip
    rrf = without / F(tmel)
    res = {
        'unmitigatedFrequencyPerYr': float(unmit),
        'iplProduct': float(ip),
        'credited': credited,
        'notCredited': not_credited,
        'mitigatedFrequencyWithoutSifPerYr': float(without),
        'requiredRrf': float(rrf),
        'requiredRrfExact': '%s/%s' % (rrf.numerator, rrf.denominator),
    }
    res.update(outcome_of_rrf(rrf))
    if sif is not None:
        w = without * F(sif)
        res['mitigatedFrequencyPerYr'] = float(w)
        res['meetsTmel'] = w <= F(tmel)
    else:
        res['mitigatedFrequencyPerYr'] = float(without)
        res['meetsTmel'] = res['outcome'] == 'NO_SIF_REQUIRED'
    return res


# ------------------------------------------------------------------ route A

KOON = {'1oo1': (1, 1), '2oo2': (2, 2), '1oo2': (1, 2), '2oo3': (2, 3), '1oo3': (1, 3)}
REDUNDANT = {'1oo2', '2oo3', '1oo3'}


def route_a(p, t1=None):
    """Annex B by the group-failure-frequency construction, exact rationals.

    lambda_D,G(koon) = k * prod_{j=0..n-k} (n-j) ... written out as the
    successive failure rates: the first failure at n lambda, the next at
    (n-1) lambda while the first is down t_G1E (= tCE), ... and the
    (n-k+1)-th failure completes the group; PFD = lambda_D,G * tGE with
    tGE the down time of that last failure, index n-k+1.
    For n = k (1oo1, 2oo2) the group fails at the first failure: rate
    n lambda_D, down time tCE.
    """
    arch = p['architecture']
    k, n = KOON[arch]
    lDU, lDD = F(p['lambdaDuPerHour']), F(p.get('lambdaDdPerHour', 0))
    T1 = F(t1 if t1 is not None else p['proofTestIntervalHours'])
    mttr, mrt = F(p.get('mttrHours', 0)), F(p.get('mrtHours', 0))
    ptc = F(p.get('proofTestCoverage', 1))
    T2 = F(p['lifetimeHours']) if ptc < 1 else None
    b = F(p.get('beta', 0)) if arch in REDUNDANT else Fr(0)
    bD = F(p.get('betaD', 0)) if arch in REDUNDANT else Fr(0)
    lD = lDU + lDD

    def du_down(j):  # down time of the j-th failure's DU share: T/(j+1) + MRT
        cov = T1 / (j + 1) + mrt
        return cov if ptc == 1 else ptc * cov + (1 - ptc) * (T2 / (j + 1) + mrt)

    def t_eq(j):
        return lDU / lD * du_down(j) + lDD / lD * mttr

    failures = n - k + 1          # failures that fail the group
    lam = (1 - bD) * lDD + (1 - b) * lDU if arch in REDUNDANT else lD
    rate = Fr(1)
    for j in range(failures):      # successive failure rates n, n-1, ...
        rate *= (n - j) * lam
    downs = Fr(1)
    for j in range(1, failures):   # down times of the failures before the last
        downs *= t_eq(j)
    group = rate * downs * t_eq(failures)
    ccf = (b * lDU * du_down(1) + bD * lDD * mttr) if arch in REDUNDANT else Fr(0)
    return group + ccf, group, ccf


# ------------------------------------------------------------------ route B

def simpson(fn, a, b, m=400):
    if b <= a:
        return 0.0
    h = (b - a) / (2 * m)
    s = fn(a) + fn(b)
    for i in range(1, 2 * m):
        s += (4 if i % 2 else 2) * fn(a + i * h)
    return s * h / 3


def route_b(p, beta_2oo2=None):
    """Time average of the exact time-dependent unavailability."""
    arch = p['architecture']
    k, n = KOON[arch]
    lDU = float(p['lambdaDuPerHour'])
    lDD = float(p.get('lambdaDdPerHour', 0))
    T1 = float(p['proofTestIntervalHours'])
    mttr, mrt = float(p.get('mttrHours', 0)), float(p.get('mrtHours', 0))
    ptc = float(p.get('proofTestCoverage', 1))
    T2 = float(p['lifetimeHours']) if ptc < 1 else T1
    if arch in REDUNDANT:
        b, bD = float(p.get('beta', 0)), float(p.get('betaD', 0))
    elif beta_2oo2 is not None:
        b, bD = beta_2oo2, beta_2oo2
    else:
        b, bD = 0.0, 0.0

    def component(rate_cov, rate_unc, rate_dd):
        def q(t):
            s = math.fmod(t, T1)
            qc = -math.expm1(-rate_cov * s)
            if s < mrt:  # failed at the previous test, still in repair
                prev = -math.expm1(-rate_cov * T1)
                qc = 1 - (1 - prev) * (1 - qc)
            qu = -math.expm1(-rate_unc * t)
            if t < mrt and rate_unc > 0:
                prev = -math.expm1(-rate_unc * T2)
                qu = 1 - (1 - prev) * (1 - qu)
            qd = rate_dd * mttr / (1 + rate_dd * mttr)
            return 1 - (1 - qc) * (1 - qu) * (1 - qd)
        return q

    ind = component((1 - b) * ptc * lDU, (1 - b) * (1 - ptc) * lDU, (1 - bD) * lDD)
    ccf = component(b * ptc * lDU, b * (1 - ptc) * lDU, bD * lDD)
    need = n - k + 1

    def U(t):
        qi = ind(t)
        pf = sum(math.comb(n, m) * qi ** m * (1 - qi) ** (n - m) for m in range(need, n + 1))
        return 1 - (1 - ccf(t)) * (1 - pf)

    # breakpoints: every test, and every MRT end
    cuts = set([0.0, T2])
    kk = 0
    while kk * T1 < T2 - 1e-9:
        cuts.add(kk * T1)
        if mrt > 0:
            cuts.add(min(kk * T1 + mrt, T2))
        kk += 1
    cuts = sorted(cuts)
    total = 0.0
    for a, c in zip(cuts[:-1], cuts[1:]):
        eps = (c - a) * 1e-12  # keep the fmod on the correct side of a test
        total += simpson(U, a + eps, c - eps, 300) + U(a + eps) * eps + U(c - eps) * eps
    return total / T2


# ------------------------------------------------------------------ max T1

def poly_coeffs(p):
    """Exact coefficients of PFD(T1): degree <= 3, Lagrange on Fractions."""
    xs = [Fr(0), Fr(1), Fr(2), Fr(3)]
    ys = [route_a(p, t1=x)[0] for x in xs]
    # Newton divided differences, then expand
    coef = list(ys)
    for j in range(1, 4):
        for i in range(3, j - 1, -1):
            coef[i] = (coef[i] - coef[i - 1]) / (xs[i] - xs[i - j])
    poly = [Fr(0)] * 4  # poly[d] is coefficient of T^d
    basis = [Fr(1)]
    for i in range(4):
        for d, c in enumerate(basis):
            poly[d] += coef[i] * c
        nb = [Fr(0)] * (len(basis) + 1)
        for d, c in enumerate(basis):
            nb[d + 1] += c
            nb[d] -= xs[i] * c
        basis = nb
    return poly


def max_interval(p, target):
    target = F(target)
    c = poly_coeffs(p)
    if F(p['lambdaDuPerHour']) == 0:
        return {'state': 'INTERVAL_INDEPENDENT'}
    if c[0] >= target:
        return {'state': 'UNACHIEVABLE', 'floorPfdAvg': float(c[0])}
    if F(p.get('proofTestCoverage', 1)) < 1:
        t2 = F(p['lifetimeHours'])
        if sum(c[d] * t2 ** d for d in range(4)) <= target:
            return {'state': 'CAPPED_AT_LIFETIME', 'proofTestIntervalHours': float(t2)}
    if c[3] == 0 and c[2] == 0:
        return {'state': 'FOUND', 'proofTestIntervalHours': float((target - c[0]) / c[1]), 'route': 'linear'}
    if c[3] == 0:
        a, bq, cq = float(c[2]), float(c[1]), float(c[0] - target)
        disc = bq * bq - 4 * a * cq
        root = (2 * cq) / (-bq - math.sqrt(disc))  # the stable form of the positive root
        return {'state': 'FOUND', 'proofTestIntervalHours': root, 'route': 'quadratic formula'}
    f = lambda x: sum(float(c[d]) * x ** d for d in range(4)) - float(target)
    lo, hi = 0.0, 1.0
    while f(hi) <= 0:
        hi *= 2
    for _ in range(300):
        mid = (lo + hi) / 2
        if f(mid) <= 0:
            lo = mid
        else:
            hi = mid
    return {'state': 'FOUND', 'proofTestIntervalHours': lo, 'route': 'bisection on the exact cubic'}


# ------------------------------------------------------------------ cases

def pfd_case(cid, source, params, printed=None, note=None, beta_2oo2=None):
    a, group, ccf = route_a(params)
    sil, state = sil_of_pfd(a) if a < 1 else (None, None)
    b = route_b(params)
    du_only = (float(params.get('lambdaDdPerHour', 0)) == 0 and float(params.get('mrtHours', 0)) == 0
               and float(params.get('proofTestCoverage', 1)) == 1)
    case = {
        'id': cid, 'source': source, 'params': params,
        'expected': {
            'pfdAvg': float(a), 'rrf': float(1 / a), 'sil': sil, 'state': state,
            'independent': float(group), 'ccf': float(ccf),
            'dominant': 'common cause' if ccf > group else 'independent',
        },
        'routeB': {'pfdAvg': b, 'departure': float(a) / b - 1},
    }
    if du_only:
        lt = float(params['lambdaDuPerHour']) * float(params['proofTestIntervalHours'])
        # rare-event linearisation departs from the exponential by at most
        # 1.5 lambda T relative for every koon here (1oo1: lT/3, 1oo2: 3lT/4,
        # 2oo3: 5lT/4, 1oo3: 6lT/5, to first order)
        case['routeB']['tolerance'] = 1.5 * lt
    if beta_2oo2 is not None:
        case['routeB2oo2WithBeta'] = {'beta': beta_2oo2, 'pfdAvg': route_b(params, beta_2oo2=beta_2oo2)}
    if printed is not None:
        case['printed'] = printed
    if note:
        case['note'] = note
    return case


def main():
    ILL = 'ORACLE-DERIVED (illustrative failure rates, not data)'
    DOLAN = 'PUBLISHED: 61508 Association, Dolan (2024), SIL Calculations: Practical Guidance in the use of IEC 61508-6:2010, results table'
    DOLAN_INF = DOLAN + ' (PTC table; T2 = 10 years is NOT printed in the text, inferred because it reproduces every printed PTC row)'
    Y = 8760

    pt = {'architecture': '2oo3', 'lambdaDuPerHour': 5e-7, 'lambdaDdPerHour': 8e-7, 'proofTestIntervalHours': Y,
          'mttrHours': 8, 'mrtHours': 8, 'beta': 0.1, 'betaD': 0.1}
    ai = {'architecture': '2oo3', 'lambdaDuPerHour': 7.06e-9, 'lambdaDdPerHour': 8.86e-7, 'proofTestIntervalHours': Y,
          'mttrHours': 8, 'mrtHours': 8, 'beta': 0.02, 'betaD': 0.01}
    cpu = {'architecture': '1oo2', 'lambdaDuPerHour': 4.9e-9, 'lambdaDdPerHour': 1.28e-6, 'proofTestIntervalHours': Y,
           'mttrHours': 8, 'mrtHours': 8, 'beta': 0.02, 'betaD': 0.01}
    do = {'architecture': '1oo2', 'lambdaDuPerHour': 6.81e-9, 'lambdaDdPerHour': 8.61e-7, 'proofTestIntervalHours': Y,
          'mttrHours': 8, 'mrtHours': 8, 'beta': 0.02, 'betaD': 0.01}
    valve = {'architecture': '1oo2', 'lambdaDuPerHour': 2.1e-6, 'lambdaDdPerHour': 4e-7, 'proofTestIntervalHours': Y,
             'mttrHours': 120, 'mrtHours': 120, 'beta': 0.1, 'betaD': 0.1}
    published = [
        pfd_case('dolan-pt-2oo3', DOLAN, pt, '2.36E-04'),
        pfd_case('dolan-ai-2oo3', DOLAN, ai, '6.97E-07'),
        pfd_case('dolan-cpu-1oo2', DOLAN, cpu, '5.34E-07'),
        pfd_case('dolan-do-1oo2', DOLAN, do, '6.68E-07'),
        pfd_case('dolan-valve-1oo2', DOLAN, valve, '1.05E-03'),
        pfd_case('dolan-pt-2oo3-beta15', DOLAN + ' (beta x 1.5 for 2oo3 per Annex D Table D.5)',
                 dict(pt, beta=0.15, betaD=0.15), '3.44E-04'),
        pfd_case('dolan-valve-1oo2-ptc85', DOLAN_INF, dict(valve, proofTestCoverage=0.85, lifetimeHours=10 * Y), '2.71E-03'),
        pfd_case('dolan-pt-2oo3-ptc90', DOLAN_INF + '; the row prints beta 10% but only 15% (the x1.5 table) reproduces 6.76E-04',
                 dict(pt, beta=0.15, betaD=0.15, proofTestCoverage=0.9, lifetimeHours=10 * Y), '6.76E-04'),
        pfd_case('dolan-cpu-1oo2-ptc98', DOLAN_INF, dict(cpu, proofTestCoverage=0.98, lifetimeHours=10 * Y), '6.12E-07'),
        pfd_case('dolan-do-1oo2-ptc98', DOLAN_INF, dict(do, proofTestCoverage=0.98, lifetimeHours=10 * Y), '7.76E-07'),
    ]
    sif_published = {
        'id': 'dolan-sif-total', 'source': DOLAN,
        'subsystems': [dict(pt, name='initiators'), dict(ai, name='A I/P'), dict(cpu, name='CPU'),
                       dict(do, name='D O/P'), dict(valve, name='final elements')],
        'expected': {},
        'printed': {'pfdAvg': '1.29E-03', 'rrf': '777'},
    }
    tot = sum(route_a(s)[0] for s in sif_published['subsystems'])
    sil, state = sil_of_pfd(tot)
    sif_published['expected'] = {'pfdAvg': float(tot), 'rrf': float(1 / tot), 'sil': sil, 'state': state}

    # simplified TR84 forms and the limits
    lam, T = 2e-6, Y
    simp = lambda arch, **kw: dict({'architecture': arch, 'lambdaDuPerHour': lam, 'proofTestIntervalHours': T}, **kw)
    derived = [
        pfd_case('tr84-1oo1', ILL, simp('1oo1'), note='lambdaDU T/2'),
        pfd_case('tr84-1oo1-with-dd', ILL, simp('1oo1', lambdaDdPerHour=5e-6, mttrHours=24),
                 note='lambdaDU T/2 + lambdaDD MTTR'),
        pfd_case('tr84-2oo2', ILL, simp('2oo2'), note='lambdaDU T; Annex B carries no beta', beta_2oo2=0.1),
        pfd_case('tr84-1oo2-beta5', ILL, simp('1oo2', beta=0.05)),
        pfd_case('tr84-2oo3-beta5', ILL, simp('2oo3', beta=0.05)),
        pfd_case('tr84-1oo3-beta5', ILL, simp('1oo3', beta=0.05)),
        pfd_case('1oo2-beta0', ILL, simp('1oo2', beta=0), note='beta = 0: pure independent, (lambda T)^2/3'),
        pfd_case('1oo2-beta1', ILL, simp('1oo2', beta=1), note='beta = 1: redundancy buys nothing, equals 1oo1'),
        pfd_case('2oo3-beta0', ILL, simp('2oo3', beta=0)),
        pfd_case('2oo3-beta1', ILL, simp('2oo3', beta=1), note='beta = 1: equals 1oo1'),
        pfd_case('1oo3-beta0', ILL, simp('1oo3', beta=0)),
        pfd_case('1oo3-beta1', ILL, simp('1oo3', beta=1)),
        pfd_case('1oo2-ccf-dominated', ILL, simp('1oo2', lambdaDuPerHour=5e-7, beta=0.1),
                 note='beta lambda T/2 = 2.19e-4 against an independent 5.2e-6: common cause is 98 percent'),
        pfd_case('1oo2-full-annexb', ILL, {'architecture': '1oo2', 'lambdaDuPerHour': 1e-6, 'lambdaDdPerHour': 4e-6,
                                          'proofTestIntervalHours': 2 * Y, 'mttrHours': 72, 'mrtHours': 72,
                                          'beta': 0.05, 'betaD': 0.025},
                 note='DD- and MRT-heavy: where the equivalent-down-time convention departs most from route B'),
        pfd_case('1oo2-mrt-ne-mttr', ILL, {'architecture': '1oo2', 'lambdaDuPerHour': 1e-6, 'lambdaDdPerHour': 5e-6,
                                          'proofTestIntervalHours': Y, 'mttrHours': 8, 'mrtHours': 168,
                                          'beta': 0.05, 'betaD': 0.02},
                 note='MRT (168 h, a DU failure found at test) differs from MTTR (8 h, a detected failure): the only rows that tell the two apart'),
        pfd_case('1oo1-mrt-ne-mttr', ILL, {'architecture': '1oo1', 'lambdaDuPerHour': 1e-6, 'lambdaDdPerHour': 5e-6,
                                          'proofTestIntervalHours': Y, 'mttrHours': 8, 'mrtHours': 168}),
        pfd_case('1oo1-long-interval', ILL, simp('1oo1', lambdaDuPerHour=1e-5, proofTestIntervalHours=5 * Y),
                 note='lambda T = 0.438: the rare-event form visibly overstates'),
        pfd_case('1oo3-full-ptc', ILL, {'architecture': '1oo3', 'lambdaDuPerHour': 3e-6, 'lambdaDdPerHour': 1e-6,
                                       'proofTestIntervalHours': Y, 'mttrHours': 8, 'mrtHours': 8,
                                       'beta': 0.05, 'betaD': 0.02, 'proofTestCoverage': 0.9,
                                       'lifetimeHours': 10 * Y}),
    ]

    bands = []
    for p in ['1', '0.5', '0.1', '0.09999', '0.01', '0.0099999', '0.001', '0.005', '0.0001', '0.00001',
              '0.0000099', '0.000001']:
        s, st = sil_of_pfd(Fr(p))
        bands.append({'pfdAvg': float(Fr(p)), 'sil': s, 'state': st})
    rrfs = []
    for r in ['0.5', '1', '1.0001', '10', '10.0001', '100', '100.0001', '1000', '1000.0001', '10000',
              '10000.0001', '20000', '100000', '200000']:
        o = outcome_of_rrf(Fr(r))
        rrfs.append(dict({'rrf': float(Fr(r))}, **o))

    SC = 'ORACLE-DERIVED (CCPS 2001 method; scenario numbers illustrative, not the book example)'
    lopa_cases = []

    def L(cid, note, **kw):
        args = {
            'initiatingEventFrequencyPerYr': kw['ief'], 'tmelPerYr': kw['tmel'],
            'enablingConditions': [{'name': n, 'probability': p} for n, p in kw.get('enabling', [])],
            'conditionalModifiers': [{'name': n, 'probability': p} for n, p in kw.get('modifiers', [])],
            'ipls': kw.get('ipls', []),
        }
        if kw.get('sif') is not None:
            args['sifPfdAvg'] = kw['sif']
        exp = lopa(kw['ief'], kw['tmel'], kw.get('enabling', []), kw.get('modifiers', []),
                   kw.get('ipls', []), kw.get('sif'))
        lopa_cases.append({'id': cid, 'source': SC, 'note': note, 'args': args, 'expected': exp})

    ind = lambda n, p: {'name': n, 'pfd': p, 'independent': True}
    L('tank-overflow-below-sil1', 'BPCS level loop failure 0.1/yr, ignition 1, presence 0.5, fatality 0.5, dike 0.01, alarm+operator 0.1; TMEL 1e-5 fatality: f 2.5e-5, RRF 2.5, needs reduction below the SIL 1 range',
      ief=0.1, tmel=1e-5, modifiers=[('ignition', 1), ('presence', 0.5), ('fatality', 0.5)],
      ipls=[ind('dike', 0.01), ind('high level alarm and operator response', 0.1)])
    # The three exact-decade cases are chosen so that the IEEE double
    # product lands JUST ABOVE the decade (100.00000000000001, and so on):
    # without the engine's decade snap each would be banded one SIL too high.
    L('rrf-exactly-100', 'f without SIF 1e-3 against TMEL 1e-5; the double product is 100.00000000000001, the exact ratio 100: SIL 1',
      ief=0.1, tmel=1e-5, ipls=[ind('relief valve', 0.1), ind('dike', 0.1)])
    L('rrf-exactly-1000', 'exact RRF 1000 (double 1000.0000000000001): SIL 2', ief=0.1, tmel=1e-5,
      modifiers=[('presence', 0.2)], ipls=[ind('check valve', 0.5)])
    L('rrf-exactly-10000', 'exact RRF 10000 (double 10000.000000000002): SIL 3, not beyond', ief=0.1, tmel=1e-6,
      modifiers=[('presence', 0.2)], ipls=[ind('check valve', 0.5)])
    L('rrf-exactly-10', 'exact RRF 10 (double 10.000000000000002) is below SIL 1', ief=0.1, tmel=1e-3, ipls=[ind('check valve', 0.1)])
    L('f-equals-tmel', 'f exactly TMEL: no SIF required', ief=0.1, tmel=1e-4, ipls=[ind('relief', 0.01), ind('dike', 0.1)])
    L('ipl-sufficient', 'the IPLs already meet TMEL: no SIF, meetsTmel true',
      ief=0.1, tmel=1e-5, modifiers=[('occupancy', 0.1)], ipls=[ind('relief valve', 0.01), ind('dike', 0.01)])
    L('beyond-sil3-sil4-band', 'RRF 2e4: beyond SIL 3, in the SIL 4 band, redesign', ief=0.2, tmel=1e-5)
    L('beyond-sil4-band', 'RRF 2e5: below the SIL 4 band, redesign', ief=2, tmel=1e-5)
    L('non-independent-not-credited', 'the BPCS alarm on the same loop as the initiating cause is not independent',
      ief=0.1, tmel=1e-5, ipls=[{'name': 'BPCS alarm (same loop)', 'pfd': 0.1, 'independent': False},
                                {'name': 'unaudited procedure', 'pfd': 0.1, 'independent': True, 'auditable': False},
                                ind('relief valve', 0.01)])
    L('enabling-and-sif', 'enabling condition 0.3, then a proposed SIF of PFD 2e-3 against the requirement',
      ief=0.5, tmel=1e-5, enabling=[('in startup mode', 0.3)], modifiers=[('ignition', 0.6)],
      ipls=[ind('relief valve', 0.01)], sif=2e-3)
    L('sif-just-short', 'a SIL 2 SIF of PFD 5e-3 against a required 3.33e-3: same band, still fails the target',
      ief=0.3, tmel=1e-5, ipls=[ind('relief valve', 0.01)], sif=5e-3)
    L('rrf-just-above-100', 'RRF 100.00001 is SIL 2', ief=0.10000001, tmel=1e-5, ipls=[ind('relief valve', 0.01)])

    sens_params = {'architecture': '1oo2', 'lambdaDuPerHour': 2e-6, 'lambdaDdPerHour': 1e-6, 'mttrHours': 8,
                   'mrtHours': 8, 'beta': 0.05, 'betaD': 0.025}
    intervals = [Y / 4, Y / 2, Y, 2 * Y, 4 * Y]
    sensitivity = {'id': 'sens-1oo2', 'source': ILL, 'params': sens_params, 'intervalsHours': intervals,
                   'rows': []}
    for t in intervals:
        v = route_a(dict(sens_params, proofTestIntervalHours=t))[0]
        s, st = sil_of_pfd(v)
        sensitivity['rows'].append({'proofTestIntervalHours': t, 'pfdAvg': float(v), 'sil': s, 'state': st})

    maxT = []
    for cid, params, target in [
        ('maxT-1oo1', {'architecture': '1oo1', 'lambdaDuPerHour': 2e-6}, 1e-2),
        ('maxT-1oo1-dd-mrt', {'architecture': '1oo1', 'lambdaDuPerHour': 2e-6, 'lambdaDdPerHour': 3e-6,
                              'mttrHours': 24, 'mrtHours': 24}, 5e-3),
        ('maxT-1oo2', sens_params, 1e-3),
        ('maxT-2oo3', dict(pt), 1e-3),
        ('maxT-1oo3', {'architecture': '1oo3', 'lambdaDuPerHour': 5e-6, 'beta': 0.02}, 1e-3),
        ('maxT-unachievable', {'architecture': '1oo1', 'lambdaDuPerHour': 1e-6, 'lambdaDdPerHour': 1e-3,
                               'mttrHours': 24}, 1e-2),
        ('maxT-capped', {'architecture': '1oo1', 'lambdaDuPerHour': 1e-8, 'proofTestCoverage': 0.9,
                         'lifetimeHours': 10 * Y}, 1e-2),
    ]:
        maxT.append({'id': cid, 'source': ILL, 'params': params, 'targetPfdAvg': target,
                     'expected': max_interval(dict(params, proofTestIntervalHours=1), target)})

    golden = {
        'module': 'lopa',
        'generatedBy': 'tools/validation/hse/oracle_lopa.py',
        'description': 'LOPA (CCPS 2001) scenario frequency, required RRF and SIL; IEC 61508-6:2010 Annex B low-demand PFDavg; bands per IEC 61508-1 Table 2. Route A exact rationals, route B time-dependent average.',
        'tolerances': {
            'routeA': 'relative 1e-12 (route A is exact; the engine is IEEE double)',
            'published': 'engine rounded to the printed three significant figures equals the printed value',
            'routeB': 'engine >= route B for every case (Annex B is conservative); and for DU-only, MRT = 0, PTC = 1 cases |engine/routeB - 1| <= 1.5 lambdaDU T1',
            'maxInterval': 'relative 1e-9',
        },
        'bands': bands,
        'rrfOutcomes': rrfs,
        'lopa': lopa_cases,
        'pfdPublished': published,
        'sifPublished': sif_published,
        'pfdDerived': derived,
        'sensitivity': sensitivity,
        'maxInterval': maxT,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(golden, fh, indent=1, sort_keys=False)
        fh.write('\n')

    # report
    print('published rows (route A vs printed):')
    for c in published:
        print('  %-26s A=%.6e printed=%s  B=%.6e dep=%+.3e' % (c['id'], c['expected']['pfdAvg'], c['printed'],
                                                            c['routeB']['pfdAvg'], c['routeB']['departure']))
    print('  SIF total %.6e (printed 1.29E-03), RRF %.1f (printed 777)' % (tot, float(1 / tot)))
    print('derived (route A, route B, departure, tolerance):')
    for c in derived:
        print('  %-22s A=%.6e B=%.6e dep=%+.4e tol=%s %s' % (
            c['id'], c['expected']['pfdAvg'], c['routeB']['pfdAvg'], c['routeB']['departure'],
            ('%.3e' % c['routeB']['tolerance']) if 'tolerance' in c['routeB'] else '-',
            ('2oo2 with beta: %.6e' % c['routeB2oo2WithBeta']['pfdAvg']) if 'routeB2oo2WithBeta' in c else ''))
    print('lopa:')
    for c in lopa_cases:
        e = c['expected']
        print('  %-30s RRF=%s %s req=%s' % (c['id'], e['requiredRrfExact'], e['outcome'], e['requiredSifPfdAvg']))
    print('maxInterval:', [(m['id'], m['expected']) for m in maxT])
    print('wrote', os.path.relpath(OUT, ROOT))


if __name__ == '__main__':
    main()
